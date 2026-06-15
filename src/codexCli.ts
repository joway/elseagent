/**
 * codexCli.ts — 使用 OpenAI Codex CLI (`codex exec`) 作为后端
 *
 * 目的：用 Codex 订阅额度替代 Anthropic API 调用。
 * 代价：只能用 Codex 自带工具（shell / 文件编辑等），
 *       本项目自定义的 memory / cron / skills 工具在此模式下不可用。
 *
 * 与 claudeCli 的差异：
 *   - 非交互子命令是 `codex exec`，prompt 从 stdin 读入。
 *   - Codex 没有 `--append-system-prompt`，故把格式要求拼进 prompt 顶部。
 *   - stdout 混有 session 日志，用 `-o <file>` 单独取最终回复最干净。
 */

import { spawn } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { traced, currentSpan } from 'braintrust'
import type { HistoryMessage, ProgressFn } from './agent.js'
import type { ToolContext } from './tools.js'
import { log } from './logger.js'

const SYSTEM_PREAMBLE = `You are a personal assistant replying via Telegram.

Format your final response using ONLY these Telegram HTML tags:
  <b>bold</b>  <i>italic</i>  <code>inline</code>  <pre>block</pre>
Escape &, <, > in plain text as &amp; &lt; &gt;.
Do NOT use Markdown (no backticks for inline code, no **bold**, no # headings).
Keep replies concise.`

function buildPrompt(userMessage: string, history: HistoryMessage[]): string {
  const parts = [SYSTEM_PREAMBLE]
  if (history.length > 0) {
    const transcript = history
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')
    parts.push(`Previous conversation:\n${transcript}`)
  }
  parts.push(`---\nNew user message:\n${userMessage}`)
  return parts.join('\n\n')
}

async function invokeCodexCli(prompt: string, ctx: ToolContext, onProgress?: ProgressFn): Promise<string> {
  const bin     = process.env.CODEX_CLI_PATH    || 'codex'
  const model   = process.env.CODEX_CLI_MODEL   || undefined
  const sandbox = process.env.CODEX_SANDBOX_MODE || 'workspace-write'

  const outFile = join(tmpdir(), `elseagent-codex-${randomUUID()}.txt`)

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', sandbox,
    '--color', 'never',
    '-o', outFile,
    '-C', ctx.workspaceDir,
  ]
  if (model) args.push('--model', model)

  log('api_req', `→ codex CLI  bin=${bin}  model=${model || '(default)'}  sandbox=${sandbox}  promptLen=${prompt.length}`)

  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    // codex 把执行进度打到 stdout（最终回复另从 outFile 读），这里转发给进度回调
    child.stdout.on('data', d => {
      if (!onProgress) return
      for (const raw of d.toString().split('\n')) {
        const line = raw.trim()
        if (line) onProgress(line.length > 100 ? line.slice(0, 100) + '…' : line)
      }
    })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', async code => {
      if (code !== 0) {
        reject(new Error(`codex CLI exited with code ${code}: ${stderr.slice(0, 500)}`))
        return
      }
      try {
        const out = (await readFile(outFile, 'utf8')).trim()
        await unlink(outFile).catch(() => {})
        resolve(out)
      } catch (err: any) {
        reject(new Error(`codex CLI produced no output file: ${err.message}`))
      }
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

export async function runAgentCodex(
  userMessage: string,
  ctx: ToolContext,
  history: HistoryMessage[] = [],
  onProgress?: ProgressFn,
): Promise<{ response: string; history: HistoryMessage[] }> {
  return traced(async () => {
    currentSpan().log({
      input: userMessage,
      metadata: { chatId: ctx.chatId, historyTurns: history.length / 2, backend: 'codex-cli' },
    })

    log('user', userMessage)
    onProgress?.('🤖 Running codex CLI…')
    const prompt = buildPrompt(userMessage, history)
    const response = await invokeCodexCli(prompt, ctx, onProgress)
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
  }, { name: 'agent-codex', event: { tags: [`chat:${ctx.chatId}`, 'backend:codex'] } })
}
