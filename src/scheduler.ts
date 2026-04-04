/**
 * scheduler.ts — 定时任务管理
 *
 * 职责：
 *   - 持久化定时任务到 workspace/crons.json
 *   - 启动时恢复所有已保存的任务
 *   - 任务触发时调用 runAgent，把结果发回对应的 Telegram chat
 *
 * 单例模式：全局只有一个 Scheduler 实例，通过 initScheduler / getScheduler 访问。
 */

// @ts-ignore — node-cron v4 没有类型声明
import cron from 'node-cron'
import { randomUUID } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import { log } from './logger.js'
import { saveMemory } from './memory.js'
import type { ToolContext } from './tools.js'

export interface CronJob {
  id: string
  expression: string  // 标准 cron 表达式，如 "0 9 * * *"
  task: string        // 传给 agent 的任务描述
  chatId: number      // 结果发送到哪个 Telegram chat
  createdAt: string
}

type SendFn = (chatId: number, text: string) => Promise<void>
type RunFn  = (task: string, ctx: ToolContext) => Promise<string>

// ─── Scheduler 类 ─────────────────────────────────────────────────────────────

export class Scheduler {
  private scheduled = new Map<string, any>()
  private jobs: CronJob[] = []
  private readonly cronFile: string

  constructor(
    private readonly baseCtx: Omit<ToolContext, 'chatId'>,
    private readonly send: SendFn,
    private readonly run: RunFn,
  ) {
    this.cronFile = path.join(baseCtx.workspaceDir, 'crons.json')
  }

  /** 从磁盘恢复任务并开始调度，启动时调用一次 */
  async init(): Promise<void> {
    try {
      const text = await fs.readFile(this.cronFile, 'utf-8')
      this.jobs = JSON.parse(text)
    } catch {
      this.jobs = []
    }
    for (const job of this.jobs) this.scheduleJob(job)
    log('info', `Scheduler: ${this.jobs.length} job(s) restored`)
  }

  /** 创建并持久化一个新的定时任务 */
  async create(expression: string, task: string, chatId: number): Promise<CronJob> {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression: "${expression}". Example: "0 9 * * *" for 9am daily.`)
    }
    const job: CronJob = {
      id: randomUUID().slice(0, 8),
      expression,
      task,
      chatId,
      createdAt: new Date().toISOString(),
    }
    this.jobs.push(job)
    this.scheduleJob(job)
    await this.persist()
    log('system', `Cron created [${job.id}] "${expression}" — ${task}`)
    return job
  }

  /** 删除一个定时任务 */
  async delete(id: string): Promise<boolean> {
    const idx = this.jobs.findIndex(j => j.id === id)
    if (idx === -1) return false
    this.scheduled.get(id)?.stop()
    this.scheduled.delete(id)
    this.jobs.splice(idx, 1)
    await this.persist()
    log('system', `Cron deleted [${id}]`)
    return true
  }

  list(): CronJob[] {
    return [...this.jobs]
  }

  // ─── 内部 ──────────────────────────────────────────────────────────────────

  private scheduleJob(job: CronJob): void {
    const task = cron.schedule(job.expression, async () => {
      log('system', `Cron fired [${job.id}] — ${job.task}`)
      const ctx: ToolContext = { ...this.baseCtx, chatId: job.chatId }
      try {
        const response = await this.run(job.task, ctx)
        await this.send(job.chatId, response)
        await saveMemory(this.baseCtx.memoryDir, job.chatId, `[Scheduled] ${job.task}`, response)
      } catch (err: any) {
        log('error', `Cron [${job.id}] failed: ${err.message}`)
        await this.send(job.chatId, `❌ Scheduled task failed: ${err.message}`)
      }
    })
    this.scheduled.set(job.id, task)
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.cronFile), { recursive: true })
    await fs.writeFile(this.cronFile, JSON.stringify(this.jobs, null, 2), 'utf-8')
  }
}

// ─── 单例 ──────────────────────────────────────────────────────────────────────

let instance: Scheduler | null = null

export function initScheduler(
  baseCtx: Omit<ToolContext, 'chatId'>,
  send: SendFn,
  run: RunFn,
): Scheduler {
  instance = new Scheduler(baseCtx, send, run)
  return instance
}

export function getScheduler(): Scheduler {
  if (!instance) throw new Error('Scheduler not initialized')
  return instance
}
