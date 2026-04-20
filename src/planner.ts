/**
 * planner.ts — 任务规划阶段
 *
 * 进入 ReAct loop 前，先判断任务是否复杂：
 *   - 简单任务 → 返回 SIMPLE，跳过规划
 *   - 复杂任务 → 返回分步列表，注入 system prompt
 *
 * 使用更快的模型（haiku）做规划，节省延迟和成本。
 */

import { traced, currentSpan } from 'braintrust'
import { getModel, complete } from '@mariozechner/pi-ai'
import { log } from './logger.js'

const PLANNER_MODEL = getModel('anthropic', 'claude-haiku-4-5')

const PLANNER_SYSTEM = `You are a task planner. Analyze the user's request and decide:

1. If it is a SIMPLE task (single action, quick answer, or one tool call) → respond with exactly: SIMPLE

2. If it requires MULTIPLE steps or coordination → respond with a numbered plan:
   Step 1: <concise action>
   Step 2: <concise action>
   ...

Rules:
- Be concise. Each step is one clear action.
- Max 8 steps.
- Do NOT explain, do NOT add commentary — only "SIMPLE" or the numbered list.

Examples of SIMPLE: "what time is it", "play music", "write hello world"
Examples that need a plan: "set up a python project with tests and CI", "scrape a website and save results to csv"`

export interface PlanResult {
  isSimple: boolean
  steps: string[]
  raw: string
}

export async function plan(userMessage: string): Promise<PlanResult> {
  return traced(async () => {
    currentSpan().log({ input: userMessage })

    log('system', 'Planning phase: analyzing task complexity...')

    const response = await complete(PLANNER_MODEL, {
      systemPrompt: PLANNER_SYSTEM,
      messages: [{ role: 'user', content: userMessage, timestamp: Date.now() }],
    }, { maxTokens: 512 })

    const raw = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { text: string }).text)
      .join('')
      .trim()

    const isSimple = raw.toUpperCase().startsWith('SIMPLE')

    const steps = isSimple
      ? []
      : raw
          .split('\n')
          .filter(line => /^Step\s*\d+:/i.test(line.trim()))
          .map(line => line.replace(/^Step\s*\d+:\s*/i, '').trim())
          .filter(Boolean)

    const result: PlanResult = { isSimple, steps, raw }

    if (isSimple) {
      log('system', 'Plan: simple task, skipping planning phase')
    } else {
      log('system', `Plan: ${steps.length} steps`, steps.map((s, i) => `${i + 1}. ${s}`).join('\n'))
    }

    currentSpan().log({ output: raw, metadata: { isSimple, stepCount: steps.length } })

    return result
  }, { name: 'planner' })
}

export function formatPlanForContext(steps: string[]): string {
  const numbered = steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
  return `## Plan\nFollow these steps in order:\n${numbered}\n\nMark each step complete before moving to the next. If a step fails, adapt and continue.`
}
