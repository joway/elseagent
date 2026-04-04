/**
 * tools.ts — 工具定义与实现
 *
 * 每个工具分两部分：
 *   1. toolDefinitions — 传给 Claude API 的 JSON schema，告诉模型工具能做什么
 *   2. executeTool     — 实际执行逻辑
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'
import { searchMemory, getRecentMemory } from './memory.js'
import { getScheduler } from './scheduler.js'

const execAsync = promisify(exec)

// ─── 工具定义（Claude API 格式） ─────────────────────────────────────────────

export const toolDefinitions = [
  {
    name: 'run_shell',
    description: [
      'Execute a shell command in the workspace directory and return stdout/stderr.',
      'Use this to: run scripts, install packages, execute code, check system state.',
      'Supports any shell command. Timeout is 60 seconds.',
    ].join(' '),
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute (e.g. "node script.js", "python3 -c \\"print(1+1)\\"", "ls -la")',
        },
      },
      required: ['command'],
    },
  },

  {
    name: 'write_file',
    description: 'Write (or overwrite) a file with the given content. Parent directories are created automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to workspace (e.g. "script.py", "src/index.ts")',
        },
        content: {
          type: 'string',
          description: 'Full file content to write',
        },
      },
      required: ['path', 'content'],
    },
  },

  {
    name: 'read_file',
    description: 'Read the content of a file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to workspace',
        },
      },
      required: ['path'],
    },
  },

  {
    name: 'list_files',
    description: 'List files and directories at a given path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to workspace (use "." for workspace root)',
        },
      },
      required: ['path'],
    },
  },

  {
    name: 'search_memory',
    description: [
      'Search past conversations by semantic similarity (vector search).',
      'Use when the user refers to a specific topic discussed before (e.g. "that Python script", "the API we discussed").',
      'NOT suitable for "what did we do recently" — use get_recent_memory instead.',
    ].join(' '),
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of what you are looking for in past conversations',
        },
        limit: {
          type: 'number',
          description: 'Max number of results to return (default 5)',
        },
      },
      required: ['query'],
    },
  },

  {
    name: 'get_recent_memory',
    description: [
      'Return the most recent N conversations, newest first.',
      'Use for questions like "what did we do just now", "what was the last task", "recap our conversation".',
    ].join(' '),
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Number of recent conversations to return (default 5)',
        },
      },
      required: [],
    },
  },

  {
    name: 'create_cron',
    description: [
      'Create a scheduled task that runs automatically on a cron schedule.',
      'The task description will be sent to the agent as a new message at each scheduled time.',
      'Results are sent back to this Telegram chat.',
    ].join(' '),
    input_schema: {
      type: 'object' as const,
      properties: {
        expression: {
          type: 'string',
          description: [
            'Standard cron expression (5 fields): "minute hour day month weekday".',
            'Examples: "0 9 * * *" = every day at 9am, "0 * * * *" = every hour, "*/30 * * * *" = every 30 minutes.',
          ].join(' '),
        },
        task: {
          type: 'string',
          description: 'Task description that the agent will execute at each scheduled time',
        },
      },
      required: ['expression', 'task'],
    },
  },

  {
    name: 'list_crons',
    description: 'List all scheduled cron jobs.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },

  {
    name: 'delete_cron',
    description: 'Delete a scheduled cron job by its ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'The cron job ID (visible in list_crons output)',
        },
      },
      required: ['id'],
    },
  },
] as const

// ─── 类型 ─────────────────────────────────────────────────────────────────────

export type ToolName = (typeof toolDefinitions)[number]['name']

export type ToolInput = {
  run_shell:        { command: string }
  write_file:       { path: string; content: string }
  read_file:        { path: string }
  list_files:       { path: string }
  search_memory:    { query: string; limit?: number }
  get_recent_memory: { limit?: number }
  create_cron:      { expression: string; task: string }
  list_crons:       Record<string, never>
  delete_cron:      { id: string }
}

export interface ToolContext {
  workspaceDir: string
  memoryDir: string
  chatId: number
}

// ─── 工具执行 ─────────────────────────────────────────────────────────────────

export async function executeTool(
  name: ToolName,
  input: ToolInput[ToolName],
  ctx: ToolContext,
): Promise<string> {
  await fs.mkdir(ctx.workspaceDir, { recursive: true })

  switch (name) {
    case 'run_shell': {
      const { command } = input as ToolInput['run_shell']
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: ctx.workspaceDir,
          timeout: 60_000,
        })
        const out = [stdout, stderr].filter(Boolean).join('\n')
        return out.trim() || '(no output)'
      } catch (err: any) {
        const out = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n')
        return `[exit code ${err.code ?? '?'}]\n${out.trim()}`
      }
    }

    case 'write_file': {
      const { path: filePath, content } = input as ToolInput['write_file']
      const abs = path.resolve(ctx.workspaceDir, filePath)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf-8')
      return `Written: ${filePath} (${content.length} bytes)`
    }

    case 'read_file': {
      const { path: filePath } = input as ToolInput['read_file']
      const abs = path.resolve(ctx.workspaceDir, filePath)
      try {
        return await fs.readFile(abs, 'utf-8') || '(empty file)'
      } catch (err: any) {
        return `Error: ${err.message}`
      }
    }

    case 'list_files': {
      const { path: dirPath } = input as ToolInput['list_files']
      const abs = path.resolve(ctx.workspaceDir, dirPath)
      try {
        const entries = await fs.readdir(abs, { withFileTypes: true })
        if (entries.length === 0) return '(empty directory)'
        return entries.map(e => `${e.isDirectory() ? 'DIR ' : 'FILE'} ${e.name}`).join('\n')
      } catch (err: any) {
        return `Error: ${err.message}`
      }
    }

    case 'search_memory': {
      const { query, limit } = input as ToolInput['search_memory']
      const results = await searchMemory(ctx.memoryDir, query, limit ?? 5)
      if (results.length === 0) return 'No matching memories found.'
      return results
        .map(e => `[${e.ts}]\nUser: ${e.user}\nAgent: ${e.agent}`)
        .join('\n\n---\n\n')
    }

    case 'get_recent_memory': {
      const { limit } = input as ToolInput['get_recent_memory']
      const results = await getRecentMemory(ctx.memoryDir, limit ?? 5)
      if (results.length === 0) return 'No memory found.'
      return results
        .map(e => `[${e.ts}]\nUser: ${e.user}\nAgent: ${e.agent}`)
        .join('\n\n---\n\n')
    }

    case 'create_cron': {
      const { expression, task } = input as ToolInput['create_cron']
      const job = await getScheduler().create(expression, task, ctx.chatId)
      return `Cron job created:\nID: ${job.id}\nSchedule: ${job.expression}\nTask: ${job.task}`
    }

    case 'list_crons': {
      const jobs = getScheduler().list()
      if (jobs.length === 0) return 'No scheduled jobs.'
      return jobs
        .map(j => `ID: ${j.id}\nSchedule: ${j.expression}\nTask: ${j.task}\nCreated: ${j.createdAt}`)
        .join('\n\n---\n\n')
    }

    case 'delete_cron': {
      const { id } = input as ToolInput['delete_cron']
      const ok = await getScheduler().delete(id)
      return ok ? `Cron job ${id} deleted.` : `No cron job found with ID: ${id}`
    }

    default:
      return `Unknown tool: ${name}`
  }
}
