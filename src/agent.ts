/**
 * agent.ts — Agent 核心循环（基于 @mariozechner/pi-agent-core）
 *
 * 由 pi-agent-core 的 Agent 类驱动整个 ReAct 循环（think → tool_use → observe → ...）。
 * 我们通过 agent.subscribe 订阅事件来打日志，业务逻辑保持不变。
 *
 * Braintrust 集成：
 *   - 保留 traced() 外层 span，记录本次 runAgent 的输入/输出和元数据
 *   - 不再用 wrapAnthropic（pi-ai 自己管 provider client）
 */

import { Agent } from '@mariozechner/pi-agent-core'
import type { AgentMessage, AgentEvent } from '@mariozechner/pi-agent-core'
import { getModel } from '@mariozechner/pi-ai'
import type { Message, AssistantMessage } from '@mariozechner/pi-ai'
import { traced, currentSpan } from 'braintrust'
import { buildTools } from './tools.js'
import type { ToolContext } from './tools.js'
import { scanSkills, buildSkillSummary } from './skills.js'
import { plan, formatPlanForContext } from './planner.js'
import { log } from './logger.js'

const MODEL = getModel('anthropic', 'claude-opus-4-6')
const MAX_ITERATIONS = 20

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

/** 把简单的历史对转换为 pi-ai 可接受的 Message[] */
function hydrateHistory(history: HistoryMessage[]): Message[] {
  return history.map<Message>(m => {
    if (m.role === 'user') {
      return { role: 'user', content: m.content, timestamp: Date.now() }
    }
    return {
      role: 'assistant',
      content: [{ type: 'text', text: m.content }],
      api: MODEL.api,
      provider: MODEL.provider,
      model: MODEL.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    }
  })
}

/** 只保留 LLM 可理解的三种 role */
function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter((m): m is Message =>
    m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
  )
}

/** 提取最后一条 assistant 消息里的纯文字 */
function extractFinalText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const am = m as AssistantMessage
    const parts = am.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text)
    if (parts.length > 0) return parts.join('\n').trim()
  }
  return ''
}

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

async function _runAgentLoop(
  userMessage: string,
  ctx: ToolContext,
  history: HistoryMessage[],
): Promise<string> {
  const skills = await scanSkills(ctx.skillsDir)
  const skillSummary = buildSkillSummary(skills, ctx.skillsDir)

  const planResult = await plan(userMessage)
  const planSection = !planResult.isSimple && planResult.steps.length > 0
    ? formatPlanForContext(planResult.steps)
    : ''

  const systemPrompt = [SYSTEM_PROMPT, skillSummary, planSection].filter(Boolean).join('\n\n')

  log('user', userMessage)

  let turn = 0
  let toolCalls = 0
  let abortedByMaxIterations = false

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: MODEL,
      tools: buildTools(ctx),
      messages: hydrateHistory(history),
    },
    convertToLlm,
    sessionId: `chat-${ctx.chatId}`,
  })

  agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case 'turn_start':
        turn++
        log('system', `--- Turn ${turn} ---`)
        if (turn > MAX_ITERATIONS) {
          abortedByMaxIterations = true
          agent.abort()
        }
        break
      case 'message_end': {
        const m = event.message
        if (m.role === 'assistant') {
          const am = m as AssistantMessage
          const u = am.usage
          const blocks = am.content.map(b => {
            if (b.type === 'text') return `[text] ${b.text.slice(0, 200)}`
            if (b.type === 'toolCall') return `[tool_use] ${b.name}(${JSON.stringify(b.arguments).slice(0, 200)})`
            if (b.type === 'thinking') return `[thinking] ${b.thinking.slice(0, 200)}`
            return `[${(b as { type: string }).type}]`
          }).join('\n')
          log('api_res', `← ${am.model}  stop=${am.stopReason}  tokens=${u.input}in/${u.output}out  cache_w=${u.cacheWrite}/cache_r=${u.cacheRead}`, blocks)
          for (const b of am.content) {
            if (b.type === 'text') log('think', b.text)
          }
        }
        break
      }
      case 'tool_execution_start':
        toolCalls++
        log('tool_call', event.toolName, event.args)
        break
      case 'tool_execution_end': {
        const content = Array.isArray(event.result?.content)
          ? event.result.content.map((c: any) => c.type === 'text' ? c.text : `[${c.type}]`).join('\n')
          : String(event.result)
        log(event.isError ? 'error' : 'tool_result', `${event.toolName} →`, content)
        break
      }
    }
  })

  await agent.prompt(userMessage)

  if (abortedByMaxIterations) {
    log('system', `Reached max iterations (${MAX_ITERATIONS}), stopping`)
  }

  const finalText = extractFinalText(agent.state.messages) || (abortedByMaxIterations ? 'Reached maximum iteration limit.' : '')
  if (finalText) log('response', finalText)

  currentSpan().log({
    metadata: {
      turns: turn,
      toolCalls,
      planned: !planResult.isSimple,
      planSteps: planResult.steps.length,
    },
  })

  return finalText
}
