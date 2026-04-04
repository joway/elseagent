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
 */

import Anthropic from '@anthropic-ai/sdk'
import { toolDefinitions, executeTool } from './tools.js'
import type { ToolName, ToolInput, ToolContext } from './tools.js'
import { log } from './logger.js'

// 懒初始化：等到 runAgent 首次调用时再创建，此时 dotenv 已经加载完毕
let claude: Anthropic | null = null
function getClient(): Anthropic {
  if (!claude) claude = new Anthropic()
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

/**
 * 运行 agent，处理单条用户消息。
 * 返回最终文字回答（用于发回 Telegram）。
 */
export async function runAgent(userMessage: string, ctx: ToolContext): Promise<string> {
  // messages 是 agent 的对话历史 / 工作记忆
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ]

  let finalResponse = ''
  let iteration = 0
  const MAX_ITERATIONS = 20 // 防止无限循环

  log('user', userMessage)

  // ─── ReAct 主循环 ────────────────────────────────────────────────────────────
  while (iteration < MAX_ITERATIONS) {
    iteration++
    log('system', `--- Iteration ${iteration} --- calling Claude API`)

    const response = await getClient().messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8096,
      system: SYSTEM_PROMPT,
      tools: toolDefinitions as unknown as Anthropic.Tool[],
      messages,
    })

    log('system', `stop_reason="${response.stop_reason}"  tokens=${response.usage.input_tokens}in/${response.usage.output_tokens}out`)

    // ── 解析响应内容块 ──────────────────────────────────────────────────────────
    const textBlocks    = response.content.filter((b): b is Anthropic.TextBlock    => b.type === 'text')
    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')

    // 打印思考内容
    for (const block of textBlocks) {
      log('think', block.text)
      finalResponse = block.text // 最后一个 text block 作为最终回答
    }

    // ── 任务完成 ────────────────────────────────────────────────────────────────
    if (response.stop_reason === 'end_turn') {
      log('response', finalResponse)
      break
    }

    // ── 执行工具调用 ────────────────────────────────────────────────────────────
    if (response.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
      // 把 assistant 的响应（包含 tool_use 块）加入历史
      messages.push({ role: 'assistant', content: response.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const block of toolUseBlocks) {
        log('tool_call', `${block.name}`, block.input)

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

      // 把工具结果作为 user 消息追加（Anthropic API 的约定）
      messages.push({ role: 'user', content: toolResults })
      continue
    }

    // 兜底：未知 stop_reason，退出循环
    log('system', `Unexpected stop_reason: ${response.stop_reason}`)
    break
  }

  if (iteration >= MAX_ITERATIONS) {
    log('system', `Reached max iterations (${MAX_ITERATIONS}), stopping`)
    finalResponse = finalResponse || 'Reached maximum iteration limit.'
  }

  return finalResponse
}
