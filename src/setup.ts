/**
 * setup.ts — 首次启动引导
 *
 * 检测 .env 是否存在且包含必填项，缺失时以交互式问答引导用户填入，
 * 最终写入 .env 文件。使用 Node.js 内置 readline，无需额外依赖。
 */

import * as fs from 'fs/promises'
import * as readline from 'readline/promises'
import * as path from 'path'
import { stdin as input, stdout as output } from 'process'

const ENV_FILE = path.resolve('.env')

interface Field {
  key: string
  label: string
  required: boolean
  default?: string
  mask?: boolean   // 输入时隐藏内容（token/key）
  hint?: string
}

const FIELDS: Field[] = [
  {
    key: 'TELEGRAM_TOKEN',
    label: 'Telegram Bot Token',
    required: true,
    mask: true,
    hint: 'Get it from @BotFather on Telegram',
  },
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API Key',
    required: true,
    mask: true,
    hint: 'Get it from console.anthropic.com',
  },
  {
    key: 'ALLOWED_CHAT_ID',
    label: 'Allowed Chat ID',
    required: false,
    hint: 'Leave empty to allow all chats. Start the bot and send a message to see your chat_id in the logs.',
  },
  {
    key: 'WORKSPACE_DIR',
    label: 'Workspace directory',
    required: false,
    default: './workspace',
    hint: 'Directory for files, memory, logs, and cron jobs',
  },
]

/** 读取现有 .env 文件，解析为 key-value map */
async function readExistingEnv(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const text = await fs.readFile(ENV_FILE, 'utf-8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim())
    }
  } catch { /* 文件不存在，返回空 map */ }
  return map
}

/** 将 key-value map 序列化为 .env 格式并写入文件 */
async function writeEnv(values: Map<string, string>): Promise<void> {
  const lines = [...values.entries()]
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
  await fs.writeFile(ENV_FILE, lines.join('\n') + '\n', 'utf-8')
}

/**
 * 检查是否需要运行引导流程。
 * 只要必填项都已配置（.env 或环境变量），就跳过引导。
 */
async function needsSetup(): Promise<boolean> {
  const existing = await readExistingEnv()
  return FIELDS
    .filter(f => f.required)
    .some(f => !existing.get(f.key) && !process.env[f.key])
}

/** 主引导流程 */
export async function runSetupIfNeeded(): Promise<void> {
  if (!(await needsSetup())) return

  const rl = readline.createInterface({ input, output })

  console.log('\n' + '═'.repeat(50))
  console.log('  ElseAgent — First-time Setup')
  console.log('═'.repeat(50) + '\n')
  console.log('No configuration found. Let\'s set up your agent.\n')

  const existing = await readExistingEnv()

  for (const field of FIELDS) {
    const currentValue = existing.get(field.key) ?? process.env[field.key] ?? ''

    // 已有值则跳过
    if (currentValue) {
      existing.set(field.key, currentValue)
      continue
    }

    if (field.hint) {
      console.log(`  \x1b[2m${field.hint}\x1b[0m`)
    }

    const placeholder = field.default ? ` (default: ${field.default})` : field.required ? ' (required)' : ' (optional, press Enter to skip)'
    const prompt = `  ${field.label}${placeholder}: `

    let value: string

    if (field.mask) {
      // 隐藏输入：关闭 echo，输入完毕后恢复
      process.stdout.write(prompt)
      value = await new Promise<string>(resolve => {
        // Node.js 在 TTY 上才能控制 echo，非 TTY 环境降级为普通读取
        if ((process.stdin as any).isTTY) {
          (process.stdin as any).setRawMode(true)
        }
        let buf = ''
        const onData = (chunk: Buffer) => {
          const ch = chunk.toString()
          if (ch === '\r' || ch === '\n') {
            if ((process.stdin as any).isTTY) (process.stdin as any).setRawMode(false)
            process.stdin.removeListener('data', onData)
            process.stdout.write('\n')
            resolve(buf)
          } else if (ch === '\x7f' || ch === '\b') {
            if (buf.length > 0) buf = buf.slice(0, -1)
          } else if (ch === '\x03') {
            process.exit(0) // Ctrl+C
          } else {
            buf += ch
            process.stdout.write('*')
          }
        }
        process.stdin.on('data', onData)
        process.stdin.resume()
      })
    } else {
      value = (await rl.question(prompt)).trim()
    }

    const finalValue = value.trim() || field.default || ''
    if (finalValue) existing.set(field.key, finalValue)

    console.log()
  }

  rl.close()

  await writeEnv(existing)

  console.log('\n\x1b[32m✓ Configuration saved to .env\x1b[0m')
  console.log('═'.repeat(50) + '\n')
}
