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

// pi-agent-core：有状态的 agent 运行时
//   - Agent 类：持有 systemPrompt/model/tools/messages 的可变状态，内部跑 agent loop
//   - AgentMessage = pi-ai 的三种 Message（user/assistant/toolResult）∪ 用户自定义消息类型
//   - AgentEvent：loop 过程中逐步发出的事件（turn/message/tool_execution 三类生命周期）
import { Agent } from '@mariozechner/pi-agent-core'
import type { AgentMessage, AgentEvent } from '@mariozechner/pi-agent-core'

// pi-ai：多 provider 的统一 LLM 客户端（Anthropic/OpenAI/Google/…）
//   - getModel(provider, id) 返回带完整类型的 Model 元数据（api、cost、context window 等）
//   - Message = UserMessage | AssistantMessage | ToolResultMessage（发给 LLM 的最小单位）
import { getModel } from '@mariozechner/pi-ai'
import type { Message, AssistantMessage } from '@mariozechner/pi-ai'
import { traced, currentSpan } from 'braintrust'
import { buildTools } from './tools.js'
import type { ToolContext } from './tools.js'
import { scanSkills, buildSkillSummary } from './skills.js'
import { plan, formatPlanForContext } from './planner.js'
import { log } from './logger.js'

// getModel 从 pi-ai 的模型注册表里查出 Model 对象（包含 api 名、provider、baseUrl、cost 等）。
// 第一个泛型参数来自 providers 联合类型，第二个参数是该 provider 下可用的 model id，
// 都会触发 TS 的自动补全；选错组合会在编译期报错。
//
// AGENT_MODEL 环境变量可覆盖默认模型（dev 模式用便宜模型省钱）。
// 懒初始化：index.ts 里 dotenv.config() 在 import 解析之后才跑，因此必须等到 runAgent
// 首次调用时才读 env，否则 .env 里的值还没被加载进 process.env。
const DEFAULT_MODEL_ID = 'claude-opus-4-6'
let _model: ReturnType<typeof getModel<'anthropic', 'claude-opus-4-6'>> | null = null
function getAgentModel() {
  if (!_model) {
    const id = process.env.AGENT_MODEL || DEFAULT_MODEL_ID
    // 运行时字符串只能 cast：getModel 的第二个参数是 keyof MODELS['anthropic'] 严格字面量联合
    _model = getModel('anthropic', id as 'claude-opus-4-6')
    log('info', `Agent model: ${_model.id}`)
  }
  return _model
}
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

/**
 * 执行过程的进度回调：agent loop 每推进一步（turn / tool）就调一次。
 * index.ts 用它把过程实时显示到 Telegram，任务结束后再撤回那条消息。
 */
export type ProgressFn = (text: string) => void

/** 把工具参数压成一行短摘要，供进度展示用 */
function summarizeArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args)
    if (!s || s === '{}') return ''
    return s.length > 80 ? s.slice(0, 80) + '…' : s
  } catch {
    return ''
  }
}

/** 把简单的历史对转换为 pi-ai 可接受的 Message[] */
function hydrateHistory(history: HistoryMessage[]): Message[] {
  const model = getAgentModel()
  return history.map<Message>(m => {
    if (m.role === 'user') {
      return { role: 'user', content: m.content, timestamp: Date.now() }
    }
    return {
      role: 'assistant',
      content: [{ type: 'text', text: m.content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    }
  })
}

/**
 * convertToLlm —— pi-agent-core 每次调 LLM 前都会用这个函数把 AgentMessage[] 过滤/转换成 Message[]。
 *
 * AgentMessage 是个超集：LLM 原生三种 role + 应用层扩展的 UI-only 消息（通过 declaration merging 加）。
 * 这里我们没扩展任何自定义 role，所以只是做一下类型 narrow，把不认识的 role 过滤掉。
 * 转换结果送进 pi-ai 的 provider（Anthropic/OpenAI/…），再由 provider 翻译成各家 API 的 wire format。
 */
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
  onProgress?: ProgressFn,
): Promise<{ response: string; history: HistoryMessage[] }> {
  return traced(async () => {
    currentSpan().log({
      input: userMessage,
      metadata: { chatId: ctx.chatId, historyTurns: history.length / 2 },
    })

    const response = await _runAgentLoop(userMessage, ctx, history, onProgress)

    currentSpan().log({ output: response })

    return { response, history: [] }
  }, { name: 'agent', event: { tags: [`chat:${ctx.chatId}`] } })
}

async function _runAgentLoop(
  userMessage: string,
  ctx: ToolContext,
  history: HistoryMessage[],
  onProgress?: ProgressFn,
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
  // 用于 agent span 的汇总指标（所有 LLM turn 累加）
  const totals = { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }

  // new Agent(...) 构造一个 agent 实例：
  //   - initialState 是可变的运行时状态，之后可通过 agent.state.xxx 随时修改
  //   - convertToLlm 是必填，用于把 AgentMessage[] 变成 LLM 能吃的 Message[]（见上方函数）
  //   - sessionId 用于 provider 的 session 缓存（Anthropic 会借此开 prompt caching，
  //     相同 sessionId 的连续请求共享 KV cache，省 tokens/延迟）
  // 框架内部维护一个循环，每轮（turn）：
  //   1) 调 convertToLlm，把当前 messages 喂给 pi-ai 的 stream()
  //   2) 流式接收 assistant message（text/thinking/toolCall 三种 content block）
  //   3) 若 stopReason == 'toolUse'：校验参数 → 并发执行所有 tool（默认 parallel）→ 写回 toolResult → 进入下一轮
  //   4) 若 stopReason == 'stop'：结束循环，发 agent_end
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: getAgentModel(),
      tools: buildTools(ctx),
      messages: hydrateHistory(history),
    },
    convertToLlm,
    sessionId: `chat-${ctx.chatId}`,
  })

  // agent.subscribe(handler) 注册事件监听器，返回 unsubscribe。
  // 所有 subscribers 按注册顺序被 await，这意味着日志/持久化等副作用可以阻塞 loop 推进。
  // 完整事件序列（一次 prompt）：
  //   agent_start
  //     turn_start
  //       message_start/message_update*/message_end   (user → assistant)
  //       tool_execution_start/update*/end           (每个工具一次)
  //       message_start/end                          (toolResult)
  //     turn_end
  //     ...（有 tool_use 就再来一轮 turn_start…）
  //   agent_end
  agent.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case 'turn_start':
        // turn = 一次「LLM 调用 + 其请求的所有 tool 执行」；我们拿它做迭代计数上限。
        // agent.abort() 通过内部 AbortController 传播到正在跑的 stream/tool，安全中断。
        turn++
        log('system', `--- Turn ${turn} ---`)
        onProgress?.(`🤔 Thinking… (turn ${turn})`)
        if (turn > MAX_ITERATIONS) {
          abortedByMaxIterations = true
          agent.abort()
        }
        break
      case 'message_end': {
        // message_end 对 user/assistant/toolResult 三种 message 都会触发。
        // 只有 assistant message 带完整的 usage/stopReason/content blocks，这里提取来打日志。
        // content 是数组，同一条 assistant message 里可能有 text/thinking/toolCall 混排。
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

          // Braintrust：为每次 LLM 调用创建一个 type:'llm' 的子 span，写入模型/token/cost。
          // Braintrust 服务端根据 metadata.model + metrics 里的标准 token 键计算 Estimated cost：
          //   - prompt_tokens / completion_tokens / tokens 是 Braintrust 的 OpenAI 风格约定
          //   - prompt_cached_tokens / prompt_cache_creation_tokens 用于缓存命中/写入
          // pi-ai 也在 usage.cost 里预算了 USD，额外作为自定义 metric 记下来当兜底（模型未在 Braintrust 注册表里时仍可见）
          totals.prompt += u.input
          totals.completion += u.output
          totals.cacheRead += u.cacheRead
          totals.cacheWrite += u.cacheWrite
          totals.total += u.totalTokens
          totals.cost += u.cost.total
          await traced(async () => {
            currentSpan().log({
              input: convertToLlm(agent.state.messages).slice(0, -1),
              output: am.content,
              metadata: { model: am.model, provider: am.provider, api: am.api, stop_reason: am.stopReason },
              metrics: {
                prompt_tokens: u.input,
                completion_tokens: u.output,
                tokens: u.totalTokens,
                prompt_cached_tokens: u.cacheRead,
                prompt_cache_creation_tokens: u.cacheWrite,
                cost_usd: u.cost.total,
              },
            })
          }, { name: `llm.${am.model}`, type: 'llm' })
        }
        break
      }
      case 'tool_execution_start':
        // args 已经被 pi-agent-core 用 TypeBox schema（AJV）校验过；校验失败时不会到这里，
        // 而是被自动转换成 isError:true 的 tool_result 回传给 LLM，让它自行纠正重试。
        toolCalls++
        log('tool_call', event.toolName, event.args)
        onProgress?.(`🔧 ${event.toolName} ${summarizeArgs(event.args)}`.trim())
        break
      case 'tool_execution_end': {
        // event.result 是 AgentToolResult 形状：{ content: (TextContent|ImageContent)[], details: any }。
        // isError=true 表示 tool 的 execute() 抛异常了，框架会用异常 message 包成 text content 回灌 LLM。
        const content = Array.isArray(event.result?.content)
          ? event.result.content.map((c: any) => c.type === 'text' ? c.text : `[${c.type}]`).join('\n')
          : String(event.result)
        log(event.isError ? 'error' : 'tool_result', `${event.toolName} →`, content)
        onProgress?.(event.isError ? `✗ ${event.toolName} failed` : `✓ ${event.toolName} done`)
        break
      }
    }
  })

  // agent.prompt(str) 等价于 push 一条 user message + 触发 loop。
  // 返回的 Promise 在 agent_end 的全部 await-subscriber 跑完后才 resolve，
  // 因此 await 结束时 agent.state.messages 已包含本轮全部新消息。
  await agent.prompt(userMessage)

  if (abortedByMaxIterations) {
    log('system', `Reached max iterations (${MAX_ITERATIONS}), stopping`)
  }

  // agent.state.messages 读到的是 accessor，返回的是内部数组的引用；赋值时会被框架复制一份。
  // prompt 结束时它已经包含：历史 + 新 user + 本轮所有 assistant/toolResult。
  const finalText = extractFinalText(agent.state.messages) || (abortedByMaxIterations ? 'Reached maximum iteration limit.' : '')
  if (finalText) log('response', finalText)

  currentSpan().log({
    metadata: {
      turns: turn,
      toolCalls,
      planned: !planResult.isSimple,
      planSteps: planResult.steps.length,
    },
    // 汇总指标挂在 agent span 上，方便在 Braintrust 列表里直接看总成本
    metrics: {
      prompt_tokens: totals.prompt,
      completion_tokens: totals.completion,
      tokens: totals.total,
      prompt_cached_tokens: totals.cacheRead,
      prompt_cache_creation_tokens: totals.cacheWrite,
      cost_usd: totals.cost,
    },
  })

  return finalText
}
