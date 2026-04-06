/**
 * skills.ts — Skill 扫描与加载
 *
 * Skill 是存放在 skillsDir 目录下的 .md 文件，格式：
 *
 *   ---
 *   name: weather
 *   description: 查询天气信息和预报
 *   ---
 *   （完整的 skill 指引，只在 agent 主动 load 时才注入 context）
 *
 * 设计原则：
 *   - 摘要（name + description）始终在 system prompt 里，让 agent 知道有哪些 skill
 *   - 完整内容按需加载，避免 context 膨胀
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { fileURLToPath } from 'url'

// 内置 skills 目录：相对于本文件所在目录的上一级（dist/ 或 src/ 的父目录）
const BUILTIN_SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills')

export interface SkillMeta {
  name: string
  description: string
  file: string   // 完整路径，供 load 时使用
}

/** 解析 markdown frontmatter，返回 meta 和 body */
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)/)
  if (!match) return { meta: {}, body: content }
  const meta: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return { meta, body: match[2] }
}

/** 扫描 skillsDir，返回所有合法 skill 的摘要列表 */
export async function scanSkills(skillsDir: string): Promise<SkillMeta[]> {
  await fs.mkdir(skillsDir, { recursive: true })
  const entries = await fs.readdir(skillsDir).catch(() => [] as string[])
  const skills: SkillMeta[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const file = path.join(skillsDir, entry)
    const content = await fs.readFile(file, 'utf-8').catch(() => '')
    const { meta } = parseFrontmatter(content)
    if (!meta.name || !meta.description) continue
    skills.push({ name: meta.name, description: meta.description, file })
  }

  return skills
}

/** 加载一个 skill 的完整 body 内容 */
export async function loadSkill(skillsDir: string, name: string): Promise<string | null> {
  const skills = await scanSkills(skillsDir)
  const skill = skills.find(s => s.name.toLowerCase() === name.toLowerCase())
  if (!skill) return null
  const content = await fs.readFile(skill.file, 'utf-8').catch(() => '')
  const { body } = parseFrontmatter(content)
  return body.trim() || null
}

/**
 * 将内置 skills 复制到用户的 skillsDir，已存在的文件不覆盖。
 * 在每次启动时调用，保证用户始终有默认 skill 可用。
 */
export async function installBuiltinSkills(skillsDir: string): Promise<void> {
  await fs.mkdir(skillsDir, { recursive: true })

  let builtins: string[]
  try {
    builtins = (await fs.readdir(BUILTIN_SKILLS_DIR)).filter(f => f.endsWith('.md'))
  } catch {
    return  // 开发环境下 builtin 目录可能不存在，静默跳过
  }

  for (const file of builtins) {
    const dest = path.join(skillsDir, file)
    try {
      await fs.access(dest)  // 已存在则跳过，保留用户的修改
    } catch {
      await fs.copyFile(path.join(BUILTIN_SKILLS_DIR, file), dest)
    }
  }
}

/** 生成注入 system prompt 的 skill 摘要段落 */
export function buildSkillSummary(skills: SkillMeta[], skillsDir: string): string {
  if (skills.length === 0) return ''
  const lines = skills.map(s => `  - ${s.name}: ${s.description}`)
  return [
    `Available skills (stored in ${skillsDir}, call load_skill when one is relevant):`,
    ...lines,
  ].join('\n')
}
