/**
 * Working signs: Delta Chat has no typing indicator, so a message the bot
 * works on carries a reaction from the bot (⏳ for a new or queued turn, 👀
 * when it went into the running turn) until the turn that took it has ended
 * and its answer was sent. Reacted messages are kept in `state.json`, so a
 * sign left by a turn that a Host restart cut off is removed at the next start.
 */
import { REQUEST_PREFIX, STEER_REACTION } from './constants.js'
import { inInbox } from './sessions.js'

/** Reaction on a message that starts a turn or waits for one. */
export const WORKING_REACTION = '⏳'

/**
 * Create the working-sign tracker.
 * @param deps - `{ ctx, getStore, getRuntime, reportError }`.
 * @returns `{ emojiFor, mark, admitted, attach, finishTurn, sweep, resume, release }`.
 */
export function createReactions({ ctx, getStore, getRuntime, reportError }) {
  /** Reacted messages by message id: `{ chatId, admitted, turn }`. */
  const tracked = new Map()
  let loaded = false

  /** Take over the messages a previous run left reacted. */
  function load() {
    if (loaded) return
    const store = getStore()
    if (store === undefined) return
    loaded = true
    for (const [msgId, chatId] of Object.entries(store.reactions())) {
      if (!tracked.has(Number(msgId))) tracked.set(Number(msgId), { chatId, admitted: true, turn: undefined })
    }
  }

  /** @returns the live agent of a chat's session, or undefined. */
  function agentOf(chatId) {
    const sessionId = getStore()?.chat(chatId)?.sessionId
    return typeof sessionId === 'string' ? ctx.get('agents')?.get(sessionId) : undefined
  }

  /**
   * The sign for a message about to go to a session.
   * @param running - whether the session runs a turn.
   * @param steer - whether a message during a turn goes into it.
   */
  function emojiFor(running, steer) {
    return running && steer ? STEER_REACTION : WORKING_REACTION
  }

  /** React to a message and remember it. */
  async function mark(chatId, msgId, emoji) {
    load()
    const runtime = getRuntime()
    if (runtime === undefined) return
    tracked.set(msgId, { chatId, admitted: false, turn: undefined })
    await getStore()?.noteReaction(msgId, chatId)
    await runtime.dc.rpc.sendReaction(runtime.accountId, msgId, [emoji]).catch((error) => reportError(`reaction on ${msgId}`, error))
  }

  /** The message reached the session, so a sweep may judge it. */
  function admitted(msgId) {
    const entry = tracked.get(msgId)
    if (entry !== undefined) entry.admitted = true
  }

  /**
   * The message is part of a turn now.
   * @param msgId - Delta Chat message id.
   * @param turn - key of the turn (session id and turn number).
   */
  function attach(msgId, turn) {
    const entry = tracked.get(msgId)
    if (entry !== undefined) entry.turn = turn
  }

  /** Remove the bot's reaction from messages. */
  async function release(msgIds) {
    const runtime = getRuntime()
    if (msgIds.length === 0 || runtime === undefined) return
    for (const msgId of msgIds) tracked.delete(msgId)
    await getStore()?.dropReactions(msgIds)
    for (const msgId of msgIds) {
      await runtime.dc.rpc.sendReaction(runtime.accountId, msgId, []).catch((error) => reportError(`reaction on ${msgId}`, error))
    }
  }

  /**
   * Messages of a chat that will get no turn: admitted, not taken into a
   * turn, and no longer waiting in the agent's inbox (dropped by /stop or
   * /clear, or a duplicate).
   */
  function dropped(chatId, { ignoreTurn = false } = {}) {
    const agent = agentOf(chatId)
    return [...tracked].filter(([msgId, entry]) => entry.chatId === chatId && entry.admitted
      && (ignoreTurn || entry.turn === undefined) && !inInbox(agent, `${REQUEST_PREFIX}${chatId}:${msgId}`)).map(([msgId]) => msgId)
  }

  /**
   * A turn ended and its answer went out: clear its messages (whatever chat
   * the session is bound to now) and the chat's dropped ones.
   */
  async function finishTurn(chatId, turn) {
    load()
    const own = [...tracked].filter(([, entry]) => entry.turn === turn).map(([msgId]) => msgId)
    await release([...own, ...dropped(chatId)])
  }

  /** Clear the signs of a chat's dropped messages. */
  async function sweep(chatId) {
    load()
    await release(dropped(chatId))
  }

  /** Clear signs whose session runs no turn, e.g. after a restart. */
  async function resume() {
    load()
    const idle = new Set([...tracked.values()].map((entry) => entry.chatId).filter((chatId) => {
      const agent = agentOf(chatId)
      return agent === undefined || agent.status === undefined || agent.status === 'idle'
    }))
    for (const chatId of idle) await release(dropped(chatId, { ignoreTurn: true }))
  }

  return { emojiFor, mark, admitted, attach, finishTurn, sweep, resume, release }
}
