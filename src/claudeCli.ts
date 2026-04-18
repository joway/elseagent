/**
 * claudeCli.ts — 使用 `claude -p` CLI 作为后端
 *
 * 目的：用 Claude Code 订阅额度替代 Anthropic API 调用，显著降低成本。
 * 代价：只能用 Claude Code 自带工具（Read/Write/Bash/Grep 等），
 *       本项目自定义的 memory / cron / skills 工具在此模式下不可用。
 *
 * 历史消息以纯文本 preamble 形式拼进 prompt，避免依赖 session 管理。
 */

import { spawn } from 'node:child_process'
import { traced, currentSpan } from 'braintrust'
import type { HistoryMessage } from './agent.js'
import type { ToolContext } from './tools.js'
import { log } from './logger.js'

const APPEND_SYSTEM_PROMPT = `You are a personal assistant replying via Telegram.

Format your final response using ONLY these Telegram HTML tags:
  <b>bold</b>  <i>italic</i>  <code>inline</code>  <pre>block</pre>
Escape &, <, > in plain text as &amp; &lt; &gt;.
Do NOT use Markdown (no backticks for inline code, no **bold**, no # headings).
Keep replies concise.`

function buildPrompt(userMessage: string, history: HistoryMessage[]): string {
  if (history.length === 0) return userMessage
  const transcript = history
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
  return `Previous conversation:\n${transcript}\n\n---\nNew user message:\n${userMessage}`
}

async function invokeClaudeCli(prompt: string): Promise<string> {
  const bin   = process.env.CLAUDE_CLI_PATH  || 'claude'
  const model = process.env.CLAUDE_CLI_MODEL || undefined

  const args = [
    '-p',
    '--output-format', 'text',
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt', APPEND_SYSTEM_PROMPT,
  ]
  if (model) args.push('--model', model)

  log('api_req', `→ claude CLI  bin=${bin}  model=${model || '(default)'}  promptLen=${prompt.length}`)

  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`))
        return
      }
      resolve(stdout.trim())
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

export async function runAgentCli(
  userMessage: string,
  ctx: ToolContext,
  history: HistoryMessage[] = [],
): Promise<{ response: string; history: HistoryMessage[] }> {
  return traced(async () => {
    currentSpan().log({
      input: userMessage,
      metadata: { chatId: ctx.chatId, historyTurns: history.length / 2, backend: 'claude-cli' },
    })

    log('user', userMessage)
    const prompt = buildPrompt(userMessage, history)
    const response = await invokeClaudeCli(prompt)
    log('response', response)

    currentSpan().log({ output: response })

    const updated: HistoryMessage[] = [
      ...history,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: response },
    ]
    const MAX_HISTORY_TURNS = 20
    const trimmed = updated.length > MAX_HISTORY_TURNS * 2
      ? updated.slice(-MAX_HISTORY_TURNS * 2)
      : updated

    return { response, history: trimmed }
  }, { name: 'agent-cli', event: { tags: [`chat:${ctx.chatId}`, 'backend:cli'] } })
}
