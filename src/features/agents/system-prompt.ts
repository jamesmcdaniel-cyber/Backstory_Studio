import { composeInstructions } from '@/lib/skills/compose'

/**
 * Builds the agent's effective system prompt. Skills are composed into the
 * objective HERE — in the single execution path shared by manual, webhook, and
 * scheduled runs — so every trigger applies attached skills identically. Callers
 * (routes, scheduler) must pass the raw objective as the run input; they must
 * NOT pre-compose skills, or the skill text would be duplicated.
 *
 * Kept in its own dependency-light module (only `composeInstructions`) so it can
 * be unit-tested without pulling in Prisma, the model SDKs, or the worker.
 */
export function buildAgentSystemPrompt(objective: string, skillIds: string[]): string {
  return [
    'You are an autonomous agent working on behalf of a user. Follow these instructions:',
    composeInstructions(objective, skillIds),
    'Use the connected tools when needed. If you are blocked on a decision, missing information, or approval that only the user can provide, call the ask_user tool and wait for the reply; for minor choices, use your best judgment and note it.',
    'When finished, report completed work, blockers, and errors factually. Only claim actions that are supported by tool results from this run.',
    'Keep the final response brief and skimmable: lead with the answer or key outcome in 1–2 sentences, then a few tight bullets for the essentials. Avoid long preambles, restating the task, and section headers unless the user asked for a detailed report. Prefer the shortest response that fully answers.',
  ].join('\n')
}
