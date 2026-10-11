import { join } from 'node:path'
import Include from '@deepseek-ai/cordis-plugin-include'
export const name = 'gear-native-policy'
export const inject = ['loader', 'agentDefaultModel', 'settings', 'systemPrompt']
export async function apply(ctx, config) {
  if (config.target)
    await ctx.plugin(Include, { path: join(config.target, 'preset/agent.cordis.yml'), enableLogs: false })
  await ctx.agentDefaultModel.saveSelection({ provider: 'openai-codex', model: config.model, reasoningEffort: 'low' })
  ctx.provide('gearNativeTarget', Object.freeze({ model: config.model, target: config.target }))
}
