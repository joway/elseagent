/**
 * tools.ts — AgentTool 定义（pi-agent-core 格式）
 *
 * 每个工具使用 TypeBox schema 描述参数，execute 返回 AgentToolResult。
 * 工具抛出异常会被 agent 捕获并作为 isError:true 的 tool_result 回传给模型。
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'
// TypeBox：JSON-Schema-in-TypeScript，pi-ai/agent-core 用它描述 tool 参数。
// Type.Object/String/Number/... 构造出的 schema 同时是：
//   - 运行时对象：被 AJV 用于参数校验（失败自动反馈给 LLM 让其重试）
//   - 编译期类型：Static<typeof schema> 推导出 execute() 里 params 的精确类型
// 因此下面 execute 里 { command, path, ... } 解构无需手写类型。
import { Type } from '@sinclair/typebox'

// AgentTool：pi-agent-core 的工具契约，比 pi-ai 的 Tool 多了 label、executionMode、execute 等。
// AgentToolResult：execute 的返回形状 { content: (TextContent|ImageContent)[], details }。
//   - content 会被包成 toolResult 消息回传给 LLM
//   - details 仅供宿主 UI/日志用，LLM 看不到
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { searchMemory, getRecentMemory } from './memory.js'
import { getScheduler } from './scheduler.js'
import { loadSkill } from './skills.js'

const execAsync = promisify(exec)

export interface ToolContext {
  workspaceDir: string
  memoryDir: string
  skillsDir: string
  chatId: number
}

const text = (s: string): AgentToolResult<unknown> => ({
  content: [{ type: 'text', text: s }],
  details: {},
})

// 每个 AgentTool 字段的语义：
//   name        —— 传给 LLM 的函数名（LLM 在 toolCall.name 里引用）
//   label       —— 仅给 UI 用的人类可读名，LLM 看不到
//   description —— 送给 LLM 的函数用途说明，影响选择工具的准确率
//   parameters  —— TypeBox schema，序列化到 LLM 作为 JSON Schema；调用时自动 AJV 校验
//   execute     —— 实际执行体，签名 (toolCallId, validatedParams, signal?, onUpdate?) => Promise<AgentToolResult>
//                  抛异常 = 报告失败（框架自动转成 isError:true 的 toolResult）
//                  onUpdate 可流式推送 partialResult，触发 tool_execution_update 事件
// buildTools 每次调用构造新数组，闭包捕获 ctx（chatId 等），避免全局状态。
export function buildTools(ctx: ToolContext): AgentTool<any>[] {
  return [
    {
      name: 'run_shell',
      label: 'Shell',
      description: [
        'Execute a shell command in the workspace directory and return stdout/stderr.',
        'Use this to: run scripts, install packages, execute code, check system state.',
        'Supports any shell command. Timeout is 60 seconds.',
      ].join(' '),
      parameters: Type.Object({
        command: Type.String({
          description: 'The shell command to execute (e.g. "node script.js", "python3 -c \\"print(1+1)\\"", "ls -la")',
        }),
      }),
      execute: async (_id, { command }) => {
        await fs.mkdir(ctx.workspaceDir, { recursive: true })
        try {
          const { stdout, stderr } = await execAsync(command, { cwd: ctx.workspaceDir, timeout: 60_000 })
          const out = [stdout, stderr].filter(Boolean).join('\n')
          return text(out.trim() || '(no output)')
        } catch (err: any) {
          const out = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n')
          return text(`[exit code ${err.code ?? '?'}]\n${out.trim()}`)
        }
      },
    },

    {
      name: 'run_applescript',
      label: 'AppleScript',
      description: [
        'Execute an AppleScript to control macOS applications and system settings.',
        'Use this to control Music.app, Spotify, volume, Finder, notifications, etc.',
        'Examples:',
        '  Play Music.app: tell application "Music" to play',
        '  Pause Spotify:  tell application "Spotify" to pause',
        '  Next track:     tell application "Music" to next track',
        '  Set volume:     set volume output volume 50',
        '  Get track info: tell application "Music" to get {name, artist} of current track',
      ].join(' '),
      parameters: Type.Object({
        script: Type.String({
          description: 'AppleScript code to execute (do not wrap in osascript, just the script body)',
        }),
      }),
      execute: async (_id, { script }) => {
        try {
          const { stdout, stderr } = await execAsync(`osascript -e ${JSON.stringify(script)}`)
          const out = [stdout, stderr].filter(Boolean).join('\n')
          return text(out.trim() || '(no output)')
        } catch (err: any) {
          const out = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n')
          return text(`[AppleScript error]\n${out.trim()}`)
        }
      },
    },

    {
      name: 'write_file',
      label: 'Write File',
      description: 'Write (or overwrite) a file with the given content. Parent directories are created automatically.',
      parameters: Type.Object({
        path: Type.String({ description: 'File path relative to workspace (e.g. "script.py", "src/index.ts")' }),
        content: Type.String({ description: 'Full file content to write' }),
      }),
      execute: async (_id, { path: filePath, content }) => {
        await fs.mkdir(ctx.workspaceDir, { recursive: true })
        const abs = path.resolve(ctx.workspaceDir, filePath)
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await fs.writeFile(abs, content, 'utf-8')
        return text(`Written: ${filePath} (${content.length} bytes)`)
      },
    },

    {
      name: 'read_file',
      label: 'Read File',
      description: "Read the content of a file.",
      parameters: Type.Object({
        path: Type.String({ description: 'File path relative to workspace' }),
      }),
      execute: async (_id, { path: filePath }) => {
        const abs = path.resolve(ctx.workspaceDir, filePath)
        try {
          const content = await fs.readFile(abs, 'utf-8')
          return text(content || '(empty file)')
        } catch (err: any) {
          return text(`Error: ${err.message}`)
        }
      },
    },

    {
      name: 'list_files',
      label: 'List Files',
      description: 'List files and directories at a given path.',
      parameters: Type.Object({
        path: Type.String({ description: 'Directory path relative to workspace (use "." for workspace root)' }),
      }),
      execute: async (_id, { path: dirPath }) => {
        const abs = path.resolve(ctx.workspaceDir, dirPath)
        try {
          const entries = await fs.readdir(abs, { withFileTypes: true })
          if (entries.length === 0) return text('(empty directory)')
          return text(entries.map(e => `${e.isDirectory() ? 'DIR ' : 'FILE'} ${e.name}`).join('\n'))
        } catch (err: any) {
          return text(`Error: ${err.message}`)
        }
      },
    },

    {
      name: 'search_memory',
      label: 'Search Memory',
      description: [
        'Search past conversations by semantic similarity (vector search).',
        'Use when the user refers to a specific topic discussed before (e.g. "that Python script", "the API we discussed").',
        'NOT suitable for "what did we do recently" — use get_recent_memory instead.',
      ].join(' '),
      parameters: Type.Object({
        query: Type.String({ description: 'Natural language description of what you are looking for in past conversations' }),
        limit: Type.Optional(Type.Number({ description: 'Max number of results to return (default 5)' })),
      }),
      execute: async (_id, { query, limit }) => {
        const results = await searchMemory(ctx.memoryDir, query, limit ?? 5)
        if (results.length === 0) return text('No matching memories found.')
        return text(results.map(e => `[${e.ts}]\nUser: ${e.user}\nAgent: ${e.agent}`).join('\n\n---\n\n'))
      },
    },

    {
      name: 'get_recent_memory',
      label: 'Recent Memory',
      description: [
        'Return the most recent N conversations, newest first.',
        'Use for questions like "what did we do just now", "what was the last task", "recap our conversation".',
      ].join(' '),
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: 'Number of recent conversations to return (default 5)' })),
      }),
      execute: async (_id, { limit }) => {
        const results = await getRecentMemory(ctx.memoryDir, limit ?? 5)
        if (results.length === 0) return text('No memory found.')
        return text(results.map(e => `[${e.ts}]\nUser: ${e.user}\nAgent: ${e.agent}`).join('\n\n---\n\n'))
      },
    },

    {
      name: 'create_cron',
      label: 'Create Cron',
      description: [
        'Create a scheduled task that runs automatically on a cron schedule.',
        'The task description will be sent to the agent as a new message at each scheduled time.',
        'Results are sent back to this Telegram chat.',
      ].join(' '),
      parameters: Type.Object({
        expression: Type.String({
          description: [
            'Standard cron expression (5 fields): "minute hour day month weekday".',
            'Examples: "0 9 * * *" = every day at 9am, "0 * * * *" = every hour, "*/30 * * * *" = every 30 minutes.',
          ].join(' '),
        }),
        task: Type.String({ description: 'Task description that the agent will execute at each scheduled time' }),
      }),
      execute: async (_id, { expression, task }) => {
        const job = await getScheduler().create(expression, task, ctx.chatId)
        return text(`Cron job created:\nID: ${job.id}\nSchedule: ${job.expression}\nTask: ${job.task}`)
      },
    },

    {
      name: 'list_crons',
      label: 'List Crons',
      description: 'List all scheduled cron jobs.',
      parameters: Type.Object({}),
      execute: async () => {
        const jobs = getScheduler().list()
        if (jobs.length === 0) return text('No scheduled jobs.')
        return text(jobs.map(j => `ID: ${j.id}\nSchedule: ${j.expression}\nTask: ${j.task}\nCreated: ${j.createdAt}`).join('\n\n---\n\n'))
      },
    },

    {
      name: 'delete_cron',
      label: 'Delete Cron',
      description: 'Delete a scheduled cron job by its ID.',
      parameters: Type.Object({
        id: Type.String({ description: 'The cron job ID (visible in list_crons output)' }),
      }),
      execute: async (_id, { id }) => {
        const ok = await getScheduler().delete(id)
        return text(ok ? `Cron job ${id} deleted.` : `No cron job found with ID: ${id}`)
      },
    },

    {
      name: 'load_skill',
      label: 'Load Skill',
      description: [
        'Load the full instructions of a skill by name.',
        "Call this when you identify that a skill listed in the system prompt is relevant to the user's request.",
        'The returned instructions will guide how to best complete the task.',
      ].join(' '),
      parameters: Type.Object({
        name: Type.String({ description: 'The skill name exactly as listed in the system prompt' }),
      }),
      execute: async (_id, { name }) => {
        const content = await loadSkill(ctx.skillsDir, name)
        return text(content ?? `Skill "${name}" not found.`)
      },
    },
  ]
}
