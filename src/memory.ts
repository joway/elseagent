/**
 * memory.ts — 对话记忆的持久化与检索
 *
 * 存储格式：JSONL，按月分文件，每行一条对话记录（含向量）。
 *   memory/2026-04.jsonl
 *   {"ts":"...","chatId":123,"user":"...","agent":"...","embedding":[0.1,0.2,...]}
 *
 * 检索策略：
 *   - searchMemory  — 向量相似度（余弦），语义搜索
 *   - getRecentMemory — 直接返回最近 N 条，不做任何匹配
 *
 * Embedding 模型：Xenova/all-MiniLM-L6-v2（384 维，~30MB，本地运行，无需 API）
 * 首次调用时自动下载模型，之后完全离线。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
// @ts-ignore — @xenova/transformers 没有完整的类型声明
import { pipeline } from '@xenova/transformers'

// ─── Embedding ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedder: any = null

/** 懒加载模型，首次调用时下载（约 30MB），之后从磁盘缓存读取 */
async function getEmbedder(): Promise<any> {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  }
  return embedder
}

/** 将文本转换为归一化向量 */
async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbedder()
  const output = await pipe(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data as Float32Array)
}

/**
 * 余弦相似度。
 * 因为向量已经归一化（normalize: true），余弦相似度 = 点积，计算更简单。
 */
function cosineSim(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

// ─── 数据类型 ─────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  ts: string
  chatId: number
  user: string
  agent: string
  embedding?: number[]  // 旧条目可能没有 embedding，兼容处理
}

// ─── 文件工具 ─────────────────────────────────────────────────────────────────

function currentFile(memoryDir: string): string {
  const month = new Date().toISOString().slice(0, 7) // "2026-04"
  return path.join(memoryDir, `${month}.jsonl`)
}

async function allFiles(memoryDir: string): Promise<string[]> {
  await fs.mkdir(memoryDir, { recursive: true })
  const entries = await fs.readdir(memoryDir).catch(() => [] as string[])
  return entries
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .map(f => path.join(memoryDir, f))
}

async function readAllEntries(memoryDir: string): Promise<MemoryEntry[]> {
  const files = await allFiles(memoryDir)
  const results: MemoryEntry[] = []
  for (const file of files) {
    const text = await fs.readFile(file, 'utf-8').catch(() => '')
    for (const line of text.split('\n').filter(Boolean)) {
      try { results.push(JSON.parse(line)) } catch { /* skip corrupted lines */ }
    }
  }
  return results
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 保存一条对话到 memory，同时生成并存储 embedding。
 * embedding 文本 = "User: {user}\nAgent: {agent}"，涵盖双方内容。
 */
export async function saveMemory(
  memoryDir: string,
  chatId: number,
  user: string,
  agent: string,
): Promise<void> {
  await fs.mkdir(memoryDir, { recursive: true })
  const embedding = await embed(`User: ${user}\nAgent: ${agent}`)
  const entry: MemoryEntry = { ts: new Date().toISOString(), chatId, user, agent, embedding }
  await fs.appendFile(currentFile(memoryDir), JSON.stringify(entry) + '\n', 'utf-8')
}

/**
 * 向量语义搜索：将 query embed 后与所有条目计算余弦相似度，返回最相关的 limit 条。
 * 没有 embedding 的旧条目自动跳过。
 */
export async function searchMemory(
  memoryDir: string,
  query: string,
  limit = 5,
): Promise<MemoryEntry[]> {
  const queryVec = await embed(query)
  const entries = await readAllEntries(memoryDir)

  return entries
    .filter(e => e.embedding)
    .map(e => ({ entry: e, score: cosineSim(queryVec, e.embedding!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.entry)
}

/**
 * 返回最近 limit 条对话（时间倒序），不做任何过滤。
 * 用于"刚才做了什么"、"最近的任务"等问题。
 */
export async function getRecentMemory(
  memoryDir: string,
  limit = 5,
): Promise<MemoryEntry[]> {
  const files = (await allFiles(memoryDir)).reverse()
  const results: MemoryEntry[] = []

  for (const file of files) {
    const text = await fs.readFile(file, 'utf-8').catch(() => '')
    const lines = text.split('\n').filter(Boolean).reverse()
    for (const line of lines) {
      try {
        results.push(JSON.parse(line))
        if (results.length >= limit) break
      } catch { /* skip */ }
    }
    if (results.length >= limit) break
  }

  return results
}
