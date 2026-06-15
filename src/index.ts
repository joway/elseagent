/**
 * index.ts — 入口：Telegram Bot
 *
 * 职责：
 *   - 监听 Telegram 消息
 *   - 鉴权（只响应 ALLOWED_CHAT_ID）
 *   - 调用 agent，把结果发回用户
 *   - 对话结束后将消息存入 memory
 *   - 初始化定时任务调度器
 *   - 简单的并发控制：同一个 chat 同时只处理一条消息
 */

import TelegramBot from 'node-telegram-bot-api'
import * as dotenv from 'dotenv'
import * as path from 'path'
import { initLogger as initBraintrust } from 'braintrust'
import { runSetupIfNeeded } from './setup.js'
import { checkAndUpdate } from './updater.js'
import { runAgent } from './agent.js'
import { runAgentCli } from './claudeCli.js'
import { runAgentCodex } from './codexCli.js'
import type { HistoryMessage } from './agent.js'
import { saveMemory } from './memory.js'
import { initScheduler } from './scheduler.js'
import { installBuiltinSkills } from './skills.js'
import { log, logSeparator, initLogger } from './logger.js'
import type { ToolContext } from './tools.js'

// 首次启动时引导用户填写配置，之后写入 .env 再由 dotenv 加载
await runSetupIfNeeded()
dotenv.config()

// 检查 npm 是否有新版本，有则自动更新并重启
await checkAndUpdate()

// ─── 配置 ─────────────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID
const WORKSPACE_DIR   = path.resolve(process.env.WORKSPACE_DIR ?? './workspace')
const LOG_DIR         = path.resolve(process.env.LOG_DIR    ?? path.join(WORKSPACE_DIR, 'logs'))
const MEMORY_DIR      = path.resolve(process.env.MEMORY_DIR ?? path.join(WORKSPACE_DIR, 'memory'))
const SKILLS_DIR      = path.resolve(process.env.SKILLS_DIR ?? path.join(WORKSPACE_DIR, 'skills'))

// 后端选择（AGENT_BACKEND）：
//   claude → `claude -p`     （Claude Code 订阅额度）
//   codex  → `codex exec`    （OpenAI Codex 订阅额度）
//   其它/空 → Anthropic API
// CLI 类后端只能用各自 CLI 自带工具，本项目的 memory/cron/skills 工具不可用。
const AGENT_BACKEND = process.env.AGENT_BACKEND ?? ''
const USE_CLI_BACKEND = AGENT_BACKEND === 'claude' || AGENT_BACKEND === 'codex'
const agentBackend =
  AGENT_BACKEND === 'claude' ? runAgentCli   :
  AGENT_BACKEND === 'codex'  ? runAgentCodex :
  runAgent
const backendLabel =
  AGENT_BACKEND === 'claude' ? 'claude -p (CLI)'   :
  AGENT_BACKEND === 'codex'  ? 'codex exec (CLI)'  :
  'Anthropic API'

if (!TELEGRAM_TOKEN) {
  console.error('Missing TELEGRAM_TOKEN in .env')
  process.exit(1)
}
// CLI 类后端靠各自订阅鉴权，无需 ANTHROPIC_API_KEY
if (!USE_CLI_BACKEND && !process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env')
  process.exit(1)
}

// ─── Bot 初始化 ───────────────────────────────────────────────────────────────

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true })

initLogger(LOG_DIR)
log('info', `Agent started`)
log('info', `Backend   : ${backendLabel}`)

// Braintrust：有 API key 则启用 tracing，无则静默跳过
if (process.env.BRAINTRUST_API_KEY) {
  await initBraintrust({ projectName: 'elseagent', apiKey: process.env.BRAINTRUST_API_KEY })
  log('info', 'Braintrust tracing enabled')
}
log('info', `Workspace : ${WORKSPACE_DIR}`)
log('info', `Memory    : ${MEMORY_DIR}`)
log('info', `Skills    : ${SKILLS_DIR}`)
await installBuiltinSkills(SKILLS_DIR)
log('info', ALLOWED_CHAT_ID ? `Restricted to chat_id: ${ALLOWED_CHAT_ID}` : 'Open to all chats (set ALLOWED_CHAT_ID to restrict)')

// ─── 发送函数（供 scheduler 回调使用） ───────────────────────────────────────

async function sendMessage(chatId: number, text: string): Promise<void> {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' })
  } catch {
    await bot.sendMessage(chatId, text)
  }
}

// ─── 进度提示（执行过程实时显示，结束后撤回） ─────────────────────────────────
//
// 思路：把 agent 执行过程中的每一步（思考 / 工具调用）作为一条「状态消息」实时
// 编辑到 Telegram 里，让用户看到进度；任务跑完拿到最终回复后，再把这条状态消息
// deleteMessage（撤回）掉，只留下最终答案，聊天记录保持干净。

const PROGRESS_MAX_LINES = 8  // 状态消息里最多展示的最近几行

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

class ProgressReporter {
  private messageId: number | null = null
  private lines: string[] = []
  private lastText = ''
  // 串行化所有 Telegram 调用，避免编辑乱序 / 并发触发限流
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly chatId: number) {}

  /** 推入一条进度，异步刷新到 Telegram（不阻塞 agent loop） */
  push(line: string): void {
    this.queue = this.queue.then(() => this.render(line)).catch(() => {})
  }

  private async render(line: string): Promise<void> {
    this.lines.push(line)
    const recent = this.lines.slice(-PROGRESS_MAX_LINES)
    const text = '⏳ <i>Working…</i>\n' + recent.map(l => '· ' + escapeHtml(l)).join('\n')
    if (text === this.lastText) return  // 内容没变就不编辑，避免 "message is not modified"
    this.lastText = text
    try {
      if (this.messageId == null) {
        const m = await bot.sendMessage(this.chatId, text, { parse_mode: 'HTML' })
        this.messageId = m.message_id
      } else {
        await bot.editMessageText(text, {
          chat_id: this.chatId,
          message_id: this.messageId,
          parse_mode: 'HTML',
        })
      }
    } catch {
      // 限流 / 已被删除等错误忽略，进度提示是尽力而为的
    }
  }

  /** 任务结束：等待挂起的编辑完成后撤回状态消息 */
  async finish(): Promise<void> {
    await this.queue
    if (this.messageId != null) {
      await bot.deleteMessage(this.chatId, this.messageId).catch(() => {})
      this.messageId = null
    }
  }
}

// ─── Scheduler 初始化 ─────────────────────────────────────────────────────────

const baseCtx: Omit<ToolContext, 'chatId'> = { workspaceDir: WORKSPACE_DIR, memoryDir: MEMORY_DIR, skillsDir: SKILLS_DIR }

const scheduler = initScheduler(baseCtx, sendMessage, agentBackend)
await scheduler.init()

// ─── 会话状态（时间窗口） ──────────────────────────────────────────────────────

// 两条消息间隔超过此时间则视为新会话，清空上下文
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MIN ?? '5') * 60 * 1000
// 每个会话最多保留的轮数（1轮 = 1问1答）
const SESSION_MAX_TURNS  = parseInt(process.env.SESSION_MAX_TURNS ?? '3')

interface SessionState {
  history:      HistoryMessage[]
  lastActivity: number   // Date.now()
}

const sessions = new Map<number, SessionState>()

// ─── 并发控制 ─────────────────────────────────────────────────────────────────

const processingChats = new Set<number>()

// ─── 消息处理 ─────────────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  const text   = msg.text?.trim()

  if (!text) return

  // 鉴权
  if (ALLOWED_CHAT_ID && chatId.toString() !== ALLOWED_CHAT_ID) {
    log('info', `Rejected message from unauthorized chat_id: ${chatId}`)
    await bot.sendMessage(chatId, '⛔ Unauthorized')
    return
  }

  // 并发控制
  if (processingChats.has(chatId)) {
    await bot.sendMessage(chatId, '⏳ Still processing your previous message, please wait...')
    return
  }

  logSeparator()
  log('info', `New message from chat_id=${chatId}`)

  processingChats.add(chatId)

  let typingInterval: ReturnType<typeof setInterval> | null = setInterval(() => {
    bot.sendChatAction(chatId, 'typing').catch(() => {})
  }, 4000)
  await bot.sendChatAction(chatId, 'typing')

  // 执行过程实时显示到 Telegram，结束后撤回
  const progress = new ProgressReporter(chatId)

  // 每条消息创建含 chatId 的 ctx（scheduler 的 create_cron 需要知道 chatId）
  const ctx: ToolContext = { ...baseCtx, chatId }

  try {
    const now     = Date.now()
    const session = sessions.get(chatId)
    const history = (session && now - session.lastActivity < SESSION_TIMEOUT_MS)
      ? session.history
      : []

    if (history.length > 0) {
      log('info', `Session active (${history.length / 2} turns)`)
    } else {
      log('info', 'New session (no prior context)')
    }

    const { response } = await agentBackend(text, ctx, history, (line) => progress.push(line))

    // 追加本轮，裁剪到 SESSION_MAX_TURNS 轮
    const updated = [...history, { role: 'user' as const, content: text }, { role: 'assistant' as const, content: response }]
    const trimmed = updated.length > SESSION_MAX_TURNS * 2 ? updated.slice(-SESSION_MAX_TURNS * 2) : updated
    sessions.set(chatId, { history: trimmed, lastActivity: now })

    await sendMessage(chatId, response)

    saveMemory(MEMORY_DIR, chatId, text, response).catch(err =>
      log('error', `Failed to save memory: ${err.message}`)
    )
  } catch (err: any) {
    log('error', `Agent error: ${err.message}`)
    await bot.sendMessage(chatId, `❌ Error: ${err.message}`)
  } finally {
    // 撤回执行过程的状态消息，只留下最终回复
    await progress.finish()
    if (typingInterval) {
      clearInterval(typingInterval)
      typingInterval = null
    }
    processingChats.delete(chatId)
  }
})

// 优雅退出
process.on('SIGINT', () => {
  log('info', 'Shutting down...')
  bot.stopPolling()
  process.exit(0)
})
