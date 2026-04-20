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
// pi-ai 直接用，不走 Agent：这里只要一次性的单轮 LLM 调用，无工具、无循环。
//   - getModel(provider, id) 查表拿 Model 元数据
//   - complete(model, context, options) 一次性跑完流并返回完整 AssistantMessage（内部也是走 stream，只是聚合好）
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
  // planner span 改成 type:'llm'：这是一次纯 LLM 调用，让 Braintrust 按 LLM span 计算成本
  return traced(async () => {
    currentSpan().log({ input: userMessage })

    log('system', 'Planning phase: analyzing task complexity...')

    // complete() 第二个参数是 Context：{ systemPrompt?, messages, tools? }。
    // messages 里每条必须带 timestamp（pi-ai 的 Message schema 要求），content 可以是字符串或 block[]。
    // 第三个参数是 SimpleStreamOptions：maxTokens/temperature/signal/sessionId/reasoning 等；
    // 不传 tools 就是纯对话，stopReason 只会是 'stop' 或 'length'。
    const response = await complete(PLANNER_MODEL, {
      systemPrompt: PLANNER_SYSTEM,
      messages: [{ role: 'user', content: userMessage, timestamp: Date.now() }],
    }, { maxTokens: 512 })

    // complete() 返回完整的 AssistantMessage：{ role:'assistant', content: Block[], usage, stopReason, ... }。
    // content 是 block 数组而非字符串——纯文本回复里通常只有一个 TextContent block。
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

    // 把 pi-ai 算好的 usage/cost 翻译成 Braintrust 的标准指标键，让 Estimated cost 能自动计算
    const u = response.usage
    currentSpan().log({
      output: raw,
      metadata: {
        isSimple,
        stepCount: steps.length,
        model: response.model,
        provider: response.provider,
        api: response.api,
      },
      metrics: {
        prompt_tokens: u.input,
        completion_tokens: u.output,
        tokens: u.totalTokens,
        prompt_cached_tokens: u.cacheRead,
        prompt_cache_creation_tokens: u.cacheWrite,
        cost_usd: u.cost.total,
      },
    })

    return result
  }, { name: 'planner', type: 'llm' })
}

export function formatPlanForContext(steps: string[]): string {
  const numbered = steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
  return `## Plan\nFollow these steps in order:\n${numbered}\n\nMark each step complete before moving to the next. If a step fails, adapt and continue.`
}
