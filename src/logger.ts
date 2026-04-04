/**
 * logger.ts — 可观测性模块
 *
 * 同时输出到：
 *   - 终端（带颜色）
 *   - 日志文件（纯文本，按天滚动）
 *
 * 使用前调用 initLogger(logDir) 初始化文件输出。
 */

import * as fs from 'fs'
import * as path from 'path'

type StepType = 'user' | 'think' | 'tool_call' | 'tool_result' | 'response' | 'error' | 'info' | 'system'

const COLORS: Record<StepType, string> = {
  user:        '\x1b[36m',  // cyan
  think:       '\x1b[33m',  // yellow  — 模型输出的思考文字
  system:      '\x1b[2m',   // dim     — agent 自身的状态信息
  tool_call:   '\x1b[35m',  // magenta
  tool_result: '\x1b[32m',  // green
  response:    '\x1b[34m',  // blue
  error:       '\x1b[31m',  // red
  info:        '\x1b[37m',  // white
}

const ICONS: Record<StepType, string> = {
  user:        '👤',
  think:       '🤔',
  system:      '⚙️ ',
  tool_call:   '🔧',
  tool_result: '📋',
  response:    '💬',
  error:       '❌',
  info:        'ℹ️ ',
}

const RESET = '\x1b[0m'
const DIM   = '\x1b[2m'

// ─── 文件输出 ─────────────────────────────────────────────────────────────────

let logDir: string | null = null
let currentLogDate = ''   // 记录当前打开的日志文件对应的日期
let logStream: fs.WriteStream | null = null

/** 在 index.ts 启动时调用一次，传入日志目录路径 */
export function initLogger(dir: string): void {
  logDir = dir
  fs.mkdirSync(dir, { recursive: true })
  log('info', `Log file output: ${dir}`)
}

/** 返回今天的日志文件写入流，日期变化时自动滚动 */
function getStream(): fs.WriteStream | null {
  if (!logDir) return null

  const today = new Date().toISOString().slice(0, 10) // "2026-04-04"
  if (today !== currentLogDate) {
    logStream?.end()
    const file = path.join(logDir, `${today}.log`)
    logStream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf-8' })
    currentLogDate = today
  }
  return logStream
}

// ─── 核心日志函数 ─────────────────────────────────────────────────────────────

export function log(type: StepType, message: string, data?: unknown): void {
  const ts    = new Date().toISOString()
  const icon  = ICONS[type]
  const label = type.toUpperCase().padEnd(11)
  const color = COLORS[type]
  const dataText = data !== undefined
    ? '\n' + (typeof data === 'string' ? data : JSON.stringify(data, null, 2))
    : ''

  // 终端：带颜色
  console.log(`${DIM}${ts}${RESET} ${color}${icon} [${label}]${RESET} ${message}`)
  if (dataText) console.log(`${DIM}${dataText.trimStart()}${RESET}`)

  // 文件：纯文本（去掉 ANSI 转义码）
  getStream()?.write(`${ts} ${icon} [${label}] ${message}${dataText}\n`)
}

/** 打印分隔线，标记一次新的对话开始 */
export function logSeparator(): void {
  const line = '─'.repeat(60)
  console.log(`\n${line}\n`)
  getStream()?.write(`\n${line}\n\n`)
}
