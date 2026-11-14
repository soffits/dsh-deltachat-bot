/**
 * Session controls from a chat: model, reasoning effort, access mode and
 * context use, picked from numbered lists.
 */
import { defaultModelOf, effortChoices, effortName, findModel, modelName, pickedSelection, sessionModelOf } from './models.js'
import { controllerOf, currentPermission, permissionOptions, setPermission } from './sessions.js'

/** @returns `n` as a 1-based list index into `items`, or undefined. */
export function pick(items, value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 && number <= items.length ? items[number - 1] : undefined
}

/** The chat's session id, or undefined. */
export function sessionOf(bridge, chatId) {
  const id = bridge.store().chat(chatId)?.sessionId
  return typeof id === 'string' ? id : undefined
}

/** The chat session's live agent when it is loaded, or undefined. */
export function liveAgent(bridge, chatId) {
  const sessionId = sessionOf(bridge, chatId)
  return sessionId === undefined ? undefined : bridge.ctx.get('agents')?.get(sessionId)
}

/** @returns a compact token count, such as 1M or 12.3k. */
function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '?'
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`
  return String(value)
}

/** @returns context use, such as "16.8k of 1M" or "16.8k used". */
function contextLabel({ used, windowSize }) {
  if (used === undefined) return windowSize === undefined ? 'unknown' : `${formatTokens(windowSize)} window`
  return windowSize === undefined ? `${formatTokens(used)} used` : `${formatTokens(used)} of ${formatTokens(windowSize)}`
}

/** Model, effort and access mode of a chat's session. */
async function controls(bridge, chatId) {
  const catalog = await bridge.modelCatalog.load()
  const sessionId = sessionOf(bridge, chatId)
  const current = await sessionModelOf(bridge.ctx, sessionId) ?? defaultModelOf(bridge.ctx)
  const agent = liveAgent(bridge, chatId)
  const mode = currentPermission(bridge.ctx, agent)
  const modeName = permissionOptions(bridge.ctx).find((option) => option.value === mode)?.name ?? mode ?? '?'
  return { catalog, current, mode, modeName }
}

/** Context window and last request size of a chat's session. */
async function contextUse(bridge, chatId, current) {
  let windowSize
  try {
    const llm = bridge.ctx.get('llm')
    const resolve = llm?.resolveModelInfo ?? llm?.resolveModel
    const info = current === undefined || resolve === undefined ? undefined : await resolve.call(llm, current.provider, current.model)
    windowSize = info?.context?.contextWindow
  } catch {
    // Unknown.
  }
  if (windowSize === undefined) {
    const catalog = await bridge.modelCatalog.load()
    windowSize = findModel(catalog, current)?.model?.contextWindow
  }
  let used
  const sessionId = sessionOf(bridge, chatId)
  if (sessionId !== undefined) {
    try {
      const events = (await bridge.ctx.get('sessionQuery')?.readSurface(sessionId))?.events ?? []
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const usage = events[index]?.type === 'assistant/message' ? (events[index].data?.usage ?? events[index].data?.message?.usage) : undefined
        if (usage === undefined) continue
        used = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        break
      }
    } catch {
      // Unknown.
    }
  }
  return { windowSize, used }
}

/** Apply a model selection the way the Web picker does, and remember it for /new. */
async function selectModel(bridge, chatId, selection) {
  const store = bridge.store()
  store.data.picks[String(chatId)] = selection
  await store.save()
  const agent = await bridge.ensureAgent(chatId, { claim: true })
  const controller = controllerOf(bridge.ctx)
  if (typeof controller?.selectModel === 'function') {
    await controller.selectModel({ sessionId: agent.session?.id ?? agent.id, ...selection })
    return
  }
  agent.model.select(selection)
}

/** Handlers of the control commands, merged into the command table. */
export const CONTROL_HANDLERS = {
  async menu(bridge, { chatId }) {
    const { catalog, current, modeName } = await controls(bridge, chatId)
    const context = await contextUse(bridge, chatId, current)
    await bridge.notice(chatId, [
      'Session controls:',
      `🤖 Model: ${modelName(catalog, current)} — /model`,
      `🧠 Effort: ${effortName(catalog, current, 'Default')} — /effort`,
      `🛡 Access: ${modeName} — /mode`,
      `📚 Context: ${contextLabel(context)} — /context`,
    ].join('\n'))
  },

  async model(bridge, { chatId }, args) {
    const { catalog, current } = await controls(bridge, chatId)
    if (catalog === undefined || catalog.groups.length === 0) {
      await bridge.notice(chatId, 'No models are available right now.')
      return
    }
    const [first, second] = args.split(/\s+/u).filter(Boolean)
    if (first === undefined) {
      await bridge.notice(chatId, [
        `Model now: ${modelName(catalog, current)}`,
        '',
        ...catalog.groups.map((group, index) => `${index + 1}. ${group.name ?? group.id} (${group.models.length})${group.id === current?.provider ? ' ✅' : ''}`),
        ...(catalog.failures.length > 0 ? ['', `Unavailable: ${catalog.failures.map((failure) => failure.name ?? failure.id).join(', ')}`] : []),
        '',
        '/model <n> lists the models of provider n.',
      ].join('\n'))
      return
    }
    const group = pick(catalog.groups, first)
    if (group === undefined) {
      await bridge.notice(chatId, `No provider ${first}; /model lists them.`)
      return
    }
    if (second === undefined) {
      await bridge.notice(chatId, [
        `${group.name ?? group.id}:`,
        ...group.models.map((model, index) => `${index + 1}. ${model.name ?? model.id}${group.id === current?.provider && model.id === current?.model ? ' ✅' : ''}`),
        '',
        `/model ${first} <n> switches this chat's session to model n.`,
      ].join('\n'))
      return
    }
    const model = pick(group.models, second)
    if (model === undefined) {
      await bridge.notice(chatId, `No model ${second}; /model ${first} lists them.`)
      return
    }
    await selectModel(bridge, chatId, pickedSelection(current, group.id, model))
    await bridge.notice(chatId, `🤖 Model: ${model.name ?? model.id}`)
  },

  async effort(bridge, { chatId }, args) {
    const { catalog, current } = await controls(bridge, chatId)
    const model = findModel(catalog, current)?.model
    const choices = effortChoices(model, 'Default')
    if (choices.length === 0) {
      await bridge.notice(chatId, 'This model has no effort setting.')
      return
    }
    const effective = current?.reasoningEffort ?? model?.reasoning?.defaultEffort
    if (args.length === 0) {
      await bridge.notice(chatId, [
        'Reasoning effort:',
        ...choices.map((choice, index) => `${index + 1}. ${choice.name}${choice.id === effective ? ' ✅' : ''}`),
        '',
        '/effort <n> picks one.',
      ].join('\n'))
      return
    }
    const choice = pick(choices, args.split(/\s+/u)[0])
    if (choice === undefined || current === undefined) {
      await bridge.notice(chatId, `No effort ${args}; /effort lists them.`)
      return
    }
    await selectModel(bridge, chatId, { provider: current.provider, model: current.model, ...(choice.id === undefined ? {} : { reasoningEffort: choice.id }) })
    await bridge.notice(chatId, `🧠 Effort: ${choice.name}`)
  },

  async mode(bridge, { chatId }, args) {
    const options = permissionOptions(bridge.ctx)
    const { mode } = await controls(bridge, chatId)
    if (args.length === 0) {
      await bridge.notice(chatId, [
        'Access mode of this session:',
        ...options.map((option, index) => `${index + 1}. ${option.name}${option.value === mode ? ' ✅' : ''}`),
        '',
        '/mode <n> picks one.',
      ].join('\n'))
      return
    }
    const option = pick(options, args.split(/\s+/u)[0])
    if (option === undefined) {
      await bridge.notice(chatId, `No mode ${args}; /mode lists them.`)
      return
    }
    setPermission(bridge.ctx, await bridge.ensureAgent(chatId, { claim: true }), option.value)
    await bridge.notice(chatId, `🛡 Access: ${option.name}`)
  },

  async context(bridge, { chatId }) {
    const { catalog, current, modeName } = await controls(bridge, chatId)
    const context = await contextUse(bridge, chatId, current)
    await bridge.notice(chatId, [
      'Context:',
      `Model: ${modelName(catalog, current)}${current === undefined ? '' : ` (${current.provider}/${current.model})`}`,
      `Window: ${formatTokens(context.windowSize)}`,
      `Last request: ${context.used === undefined ? 'unknown' : formatTokens(context.used)}`,
      `Effort: ${effortName(catalog, current, 'Default')}`,
      `Access: ${modeName}`,
    ].join('\n'))
  },

}
