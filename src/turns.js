/**
 * Turn delivery: follow every session bound to a chat, collect each turn's
 * answer, and send it when the turn ends.
 */
import { basename } from 'node:path'
import { REQUEST_PREFIX } from './constants.js'
import { clip, localImagePaths, messageAnswer, stripSilent } from './text.js'

/**
 * Create the turn tracker.
 * @param deps - `{ ctx, getStore, isRunning, setting, outbound, chatState, publishStatus, fireAndForget, messageOf }`.
 * @returns `{ onSessionEvent, currentTurn }`.
 */
export function createTurns({ ctx, getStore, isRunning, setting, outbound, chatState, publishStatus, fireAndForget, messageOf }) {
  const { queueOut, notice, sendText, sendFiles, checkFiles } = outbound
  /** Turns of bound sessions by session id: `{ current, turns: Map<turn, record>, pendingOurs }`. */
  const sessionTurns = new Map()

  /** @returns the turn bookkeeping of a session. */
  function turnsOf(sessionId) {
    let entry = sessionTurns.get(sessionId)
    if (entry === undefined) {
      entry = { current: undefined, turns: new Map(), pendingOurs: undefined }
      sessionTurns.set(sessionId, entry)
    }
    return entry
  }

  /** @returns the record of a session's running turn, or undefined. */
  function currentTurn(sessionId) {
    const entry = sessionTurns.get(sessionId)
    return entry?.current === undefined ? undefined : entry.turns.get(entry.current)
  }

  /**
   * Follow every session bound to a chat: collect each turn's answer and send
   * it when the turn ends. Turns started from Delta Chat are always delivered;
   * turns started elsewhere (Web UI, schedules) when `mirrorTurns` is on.
   */
  function onSessionEvent(session, event) {
    const store = getStore()
    if (store === undefined || !isRunning()) return
    const sessionId = session?.id
    const chatId = store.chatOfSession(sessionId)
    if (chatId === undefined) return
    const entry = turnsOf(sessionId)
    const mirror = setting('mirrorTurns', true) === true
    if (event.type === 'turn/start') {
      const record = { texts: [], ours: entry.pendingOurs !== undefined, lastPrompt: entry.pendingOurs, goal: false, mirrored: mirror, sent: false, stopped: false }
      entry.pendingOurs = undefined
      entry.current = event.data?.turn
      entry.turns.set(event.data?.turn, record)
      return
    }
    const record = entry.current === undefined ? undefined : entry.turns.get(entry.current)
    if (event.type === 'user/message') {
      const source = event.data?.source
      const rpcId = typeof source?.rpcId === 'string' ? source.rpcId : ''
      if (source?.kind === 'user' && rpcId.startsWith(REQUEST_PREFIX)) {
        const messageId = Number(rpcId.slice(rpcId.lastIndexOf(':') + 1))
        if (record === undefined) entry.pendingOurs = messageId
        else {
          record.ours = true
          record.lastPrompt = messageId
        }
        return
      }
      if (rpcId.startsWith('deltachat-claim:')) return
      if (source?.kind === 'goal' && record !== undefined) record.goal = true
      if (!mirror) return
      const label = source?.kind === 'schedule' ? '⏰ Scheduled task' : source?.kind !== 'user' ? undefined : rpcId.startsWith('telegram') ? '✈️ From Telegram' : '🖥 From Web'
      if (label === undefined) return
      const content = Array.isArray(event.data?.content) ? event.data.content : []
      const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim()
      const files = content.filter((block) => block?.type === 'image' || block?.type === 'file').length
      if (text.length === 0 && files === 0) return
      notice(chatId, `${label}:\n${clip(text, 3000)}${files === 0 ? '' : `\n📎 ${files}`}`)
      return
    }
    if (event.type === 'assistant/message') {
      const turn = entry.turns.get(event.data?.turn) ?? record
      const answer = messageAnswer(event.data?.message ?? event.data)
      if (turn !== undefined && answer.length > 0) turn.texts.push(answer)
      return
    }
    if (event.type === 'deliverables/presented') {
      const turn = entry.turns.get(event.data?.turn) ?? record
      if (turn !== undefined && !(turn.ours || turn.goal || turn.mirrored)) return
      const paths = (Array.isArray(event.data?.files) ? event.data.files : []).map((file) => file?.path).filter((path) => typeof path === 'string')
      if (paths.length === 0) return
      if (turn !== undefined) turn.sent = true
      void queueOut(chatId, () => forwardFiles(chatId, paths))
      return
    }
    if (event.type === 'goal/change') {
      fireAndForget('goal-change', () => announceGoal(chatId, sessionId))
      return
    }
    if (event.type === 'turn/end') {
      const turn = event.data?.turn
      const finished = entry.turns.get(turn)
      entry.turns.delete(turn)
      if (entry.current === turn) entry.current = undefined
      if (finished !== undefined) void queueOut(chatId, () => deliverTurn(chatId, finished, event.data?.reason))
    }
  }

  /** Send files a session showed its user, with a note for those that cannot go. */
  async function forwardFiles(chatId, paths, quiet = false) {
    const failed = []
    for (const path of paths) {
      try {
        await sendFiles(chatId, await checkFiles([path]))
      } catch (error) {
        if (!quiet) failed.push(`${basename(path)}: ${messageOf(error)}`)
      }
    }
    if (failed.length > 0) await sendText(chatId, `⚠️ Could not send:\n${failed.join('\n')}`, { plain: true })
  }

  /** Send a finished turn's answer into its chat. */
  async function deliverTurn(chatId, turn, reason) {
    if (!(turn.ours || turn.goal || turn.mirrored)) return
    if (turn.stopped || reason?.kind === 'aborted' || reason?.kind === 'blocked') return
    const { text, silent } = stripSilent(turn.texts.join('\n\n'))
    if (reason?.kind === 'error' && text.length === 0) {
      await sendText(chatId, `❌ ${reason.error?.message ?? 'The turn failed.'}`, { plain: true })
      return
    }
    if (text.length > 0) {
      const chat = chatState(chatId)
      // Quote the prompt when the chat moved on since it was sent.
      const quote = turn.ours && Number.isSafeInteger(turn.lastPrompt) && chat.lastInbound !== turn.lastPrompt ? turn.lastPrompt : undefined
      await sendText(chatId, text, { quote })
      const images = localImagePaths(text)
      if (images.length > 0) await forwardFiles(chatId, images, true)
      await publishStatus({ lastReplyAt: Date.now() })
      return
    }
    if (turn.ours && !silent && !turn.sent && reason?.kind !== 'error') await sendText(chatId, '✅ Done.', { plain: true })
  }

  /** Tell the chat when its session's goal changes phase. */
  async function announceGoal(chatId, sessionId) {
    const goals = ctx.get('goals')
    const agent = ctx.get('agents')?.get(sessionId)
    if (goals === undefined || agent === undefined) return
    const view = goals.get(agent)
    const chat = chatState(chatId)
    const phase = view === undefined ? 'none' : view.phase
    if (chat.goalPhase === phase) return
    const previous = chat.goalPhase
    chat.goalPhase = phase
    if (previous === undefined) return
    if (phase === 'complete') await notice(chatId, `🎯 Goal complete: ${clip(view.objective, 300)}`)
    else if (phase === 'blocked') await notice(chatId, `🎯 Goal blocked: ${clip(view.objective, 300)}`)
    else if (phase === 'paused') await notice(chatId, '🎯 Goal paused. /goal resume continues it.')
  }

  return { onSessionEvent, currentTurn }
}
