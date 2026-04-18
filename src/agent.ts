/**
 * agent.ts — Agent 核心循环（ReAct 模式）
 *
 * ReAct = Reasoning + Acting
 * 每一轮循环：
 *   1. 把消息历史发给 Claude
 *   2. Claude 返回 text（思考/回答）或 tool_use（要调用工具）
 *   3. 如果是 tool_use，执行工具，把结果追加到消息历史，继续循环
 *   4. 如果是 end_turn，说明 Claude 认为任务完成，返回最终回答
 *
 * messages 数组就是 agent 的"工作记忆"，记录整个推理过程。
 *
 * Braintrust 集成：
 *   - wrapAnthropic：自动追踪每次 Claude API 调用（输入/输出/延迟/token）
 *   - traced：把整个 runAgent 调用包装成顶层 span，关联所有子调用
 */

import Anthropic from '@anthropic-ai/sdk'
import { wrapAnthropic, traced, currentSpan } from 'braintrust'
import { toolDefinitions, executeTool } from './tools.js'
import type { ToolName, ToolInput, ToolContext } from './tools.js'
import { scanSkills, buildSkillSummary } from './skills.js'
import { plan, formatPlanForContext } from './planner.js'
import { log } from './logger.js'

// 懒初始化：等到 runAgent 首次调用时再创建，此时 dotenv 已经加载完毕
// wrapAnthropic 在 Braintrust 未初始化时是 no-op，不影响正常运行
let claude: Anthropic | null = null
function getClient(): Anthropic {
  if (!claude) claude = wrapAnthropic(new Anthropic())
  return claude
}

const SYSTEM_PROMPT = `You are a personal assistant agent. You help the user accomplish tasks by reasoning step by step and using tools when needed.

You can write and run code to solve problems:
- Write code to a file with write_file, then execute it with run_shell
- Or run one-liners directly: node -e "...", python3 -c "...", bash -c "..."

Memory:
- Past conversations are saved automatically after each reply.
- Use get_recent_memory for: "what did you just do", "recap", "last task", anything about recent activity.
- Use search_memory for: finding a specific past topic with concrete keywords (e.g. "Python scraper", "AWS config").
- Do NOT guess keywords for search_memory — only use terms likely to appear verbatim in past messages.

Mac control:
- Use run_applescript to control macOS apps and system settings.
- Music.app: tell application "Music" to play / pause / next track / previous track
- Spotify:   tell application "Spotify" to play / pause / next track
- Volume:    set volume output volume 50  (0–100)
- Get current track: tell application "Music" to get {name, artist} of current track

Scheduled tasks:
- Use create_cron to set up a recurring task with a cron expression and a task description.
- The task description is what you will receive as a message when the schedule fires — make it self-contained and clear.
- Use list_crons to show existing schedules, delete_cron to remove one.
- Cron expression format: "minute hour day month weekday" (e.g. "0 9 * * *" = 9am every day).

Guidelines:
- Think out loud before calling tools — explain what you're about to do and why
- After getting a tool result, reflect on it before deciding the next step
- If a task fails, diagnose why and try a different approach

IMPORTANT — output format:
Your final response will be sent via Telegram using parse_mode HTML.
Format your response using ONLY these Telegram HTML tags:
  <b>bold</b>
  <i>italic</i>
  <code>inline code</code>
  <pre>code block</pre>
  <pre><code class="language-python">code with language</code></pre>
Escape these characters in plain text: &amp; → &amp;amp;  &lt; → &amp;lt;  &gt; → &amp;gt;
Do NOT use Markdown syntax (no backticks, no **bold**, no # headings).`

/** 对话历史中单条消息的结构（只保留文字，不保留 tool 内部状态） */
export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 运行 agent，处理单条用户消息。
 * 接受当前会话的历史记录，返回回答和更新后的历史。
 *
 * 整个调用被包在一个 Braintrust span 里，所有子 API 调用自动作为子 span 上报。
 */
export async function runAgent(
  userMessage: string,
  ctx: ToolContext,
  history: HistoryMessage[] = [],
): Promise<{ response: string; history: HistoryMessage[] }> {
  return traced(async () => {
    currentSpan().log({
      input: userMessage,
      metadata: { chatId: ctx.chatId, historyTurns: history.length / 2 },
    })

    const response = await _runAgentLoop(userMessage, ctx, history)

    currentSpan().log({ output: response })

    return { response, history: [] }
  }, { name: 'agent', event: { tags: [`chat:${ctx.chatId}`] } })
}

/** 实际的 ReAct 循环，从 runAgent 中分离以保持 traced 回调简洁 */
async function _runAgentLoop(
  userMessage: string,
  ctx: ToolContext,
  history: HistoryMessage[],
): Promise<string> {
  const skills = await scanSkills(ctx.skillsDir)
  const skillSummary = buildSkillSummary(skills, ctx.skillsDir)

  // Planning 阶段：复杂任务先生成计划，注入到 system prompt
  const planResult = await plan(userMessage)
  const planSection = !planResult.isSimple && planResult.steps.length > 0
    ? formatPlanForContext(planResult.steps)
    : ''

  // Prompt caching：把稳定的 system 内容（SYSTEM_PROMPT + skillSummary）标记为
  // cache_control breakpoint，可变的 planSection 放在后面不缓存。
  // tools 在渲染顺序上位于 system 之前，breakpoint 会同时缓存 tools + system。
  const stableText = [SYSTEM_PROMPT, skillSummary].filter(Boolean).join('\n\n')
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: stableText, cache_control: { type: 'ephemeral' } },
    ...(planSection ? [{ type: 'text' as const, text: planSection }] : []),
  ]

  // 历史消息在前，当前用户消息在最后
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: 'user', content: userMessage },
  ]

  let finalResponse = ''
  let iteration = 0
  let totalToolCalls = 0
  const MAX_ITERATIONS = 20

  log('user', userMessage)

  while (iteration < MAX_ITERATIONS) {
    iteration++
    log('system', `--- Iteration ${iteration} --- calling Claude API`)

    const lastMsg = messages.at(-1)!
    const lastContent = Array.isArray(lastMsg.content)
      ? lastMsg.content.map(b => {
          if ('type' in b && b.type === 'tool_result') return `[tool_result id=${b.tool_use_id}] ${String(b.content).slice(0, 200)}`
          return JSON.stringify(b).slice(0, 200)
        }).join('\n')
      : String(lastMsg.content).slice(0, 200)
    log('api_req', `→ Claude  model=claude-opus-4-6  messages=${messages.length}  last(${lastMsg.role}):`, lastContent)

    const response = await getClient().messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8096,
      system: systemBlocks,
      tools: toolDefinitions as unknown as Anthropic.Tool[],
      messages,
    })

    const { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } = response.usage
    const blockSummary = response.content.map(b => {
      if (b.type === 'text')     return `[text] ${b.text.slice(0, 200)}`
      if (b.type === 'tool_use') return `[tool_use] ${b.name}(${JSON.stringify(b.input).slice(0, 200)})`
      return `[${b.type}]`
    }).join('\n')
    log('api_res', `← Claude  stop_reason=${response.stop_reason}  tokens=${input_tokens}in/${output_tokens}out  cache_write=${cache_creation_input_tokens ?? 0}/cache_read=${cache_read_input_tokens ?? 0}`, blockSummary)

    const textBlocks    = response.content.filter((b): b is Anthropic.TextBlock    => b.type === 'text')
    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')

    for (const block of textBlocks) {
      log('think', block.text)
      finalResponse = block.text
    }

    if (response.stop_reason === 'end_turn') {
      log('response', finalResponse)
      break
    }

    if (response.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
      messages.push({ role: 'assistant', content: response.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const block of toolUseBlocks) {
        log('tool_call', `${block.name}`, block.input)
        totalToolCalls++

        const result = await executeTool(
          block.name as ToolName,
          block.input as ToolInput[ToolName],
          ctx,
        )

        log('tool_result', `${block.name} →`, result)

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        })
      }

      messages.push({ role: 'user', content: toolResults })
      continue
    }

    log('system', `Unexpected stop_reason: ${response.stop_reason}`)
    break
  }

  if (iteration >= MAX_ITERATIONS) {
    log('system', `Reached max iterations (${MAX_ITERATIONS}), stopping`)
    finalResponse = finalResponse || 'Reached maximum iteration limit.'
  }

  // 记录本次 loop 的统计信息到 span
  currentSpan().log({
    metadata: {
      iterations: iteration,
      toolCalls: totalToolCalls,
      planned: !planResult.isSimple,
      planSteps: planResult.steps.length,
    },
  })

  return finalResponse
}
