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

if (!TELEGRAM_TOKEN) {
  console.error('Missing TELEGRAM_TOKEN in .env')
  process.exit(1)
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env')
  process.exit(1)
}

// ─── Bot 初始化 ───────────────────────────────────────────────────────────────

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true })

initLogger(LOG_DIR)
log('info', `Agent started`)

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

// ─── Scheduler 初始化 ─────────────────────────────────────────────────────────

const baseCtx: Omit<ToolContext, 'chatId'> = { workspaceDir: WORKSPACE_DIR, memoryDir: MEMORY_DIR, skillsDir: SKILLS_DIR }

const scheduler = initScheduler(baseCtx, sendMessage, runAgent)
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

    const { response } = await runAgent(text, ctx, history)

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
