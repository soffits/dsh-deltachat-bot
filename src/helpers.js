/**
 * Helper activity: subagents started under a chat's session are shown in one
 * status message, edited in place as they start and finish and left as it is
 * once all of them are done. `/agents` lists a session's helpers on demand.
 */
import { sessionModelOf } from './models.js'
import { recentAssistantTexts } from './sessions.js'
import { clip } from './text.js'

/** Pause that lets several starts or ends share one edit. */
const EDIT_DELAY_MS = 1500
/** Parent links followed from a helper up to the chat's session. */
const MAX_DEPTH = 8
/** Helpers `/agents` lists at most. */
const LIST_LIMIT = 8

/** @returns minutes between two times, as shown in the status message. */
function minutes(from, to) {
  const value = Math.floor((to - from) / 60_000)
  return value < 1 ? '<1 min' : `${value} min`
}

/**
 * The status text of one chat's helpers.
 * @param helpers - helper records in start order.
 * @param now - current time in ms.
 */
export function boardText(helpers, now) {
  const running = helpers.filter((helper) => helper.endedAt === undefined)
  const count = (n) => `${n} helper${n === 1 ? '' : 's'}`
  const head = running.length > 0 ? `🤖 ${count(running.length)} working:` : `🤖 ${count(helpers.length)} done:`
  const lines = helpers.map((helper) => {
    const model = helper.model ? `${helper.model}, ` : ''
    if (helper.endedAt === undefined) return `⏳ ${helper.label} (${model}${minutes(helper.startedAt, now)})`
    const failed = helper.stopReason !== undefined && helper.stopReason !== 'completed'
    return `${failed ? '✗' : '✓'} ${helper.label} (${model}${minutes(helper.startedAt, helper.endedAt)}${failed ? `, ${helper.stopReason}` : ''})`
  })
  return [head, ...lines].join('\n')
}

/**
 * Create the helper tracker.
 * @param deps - `{ ctx, getStore, getRuntime, outbound, currentTurn, reportError, now }`.
 * @returns `{ onStart, onEnd, list, dispose }`.
 */
export function createHelpers({ ctx, getStore, getRuntime, outbound, currentTurn, reportError, now = Date.now }) {
  const { queueOut, sendText } = outbound
  /** Open status messages by chat id: `{ messageId, helpers: Map<runId, helper>, timer }`. */
  const boards = new Map()

  /** @returns the chat whose session started this helper (directly or through other helpers). */
  function chatOfHelper(childId) {
    const agents = ctx.get('agents')
    const store = getStore()
    let sessionId = agents?.get(childId)?.session?.header?.parentSession
    for (let depth = 0; depth < MAX_DEPTH && typeof sessionId === 'string'; depth += 1) {
      const chatId = store?.chatOfSession(sessionId)
      if (chatId !== undefined) return { chatId, sessionId }
      sessionId = agents?.get(sessionId)?.session?.header?.parentSession
    }
    return undefined
  }

  /** @returns the label a parent gave its child, from the parent's catalog. */
  async function labelOf(parentId, childId) {
    try {
      const children = await ctx.get('subagents')?.listChildren(parentId)
      const label = children?.find((child) => child.id === childId)?.label
      if (typeof label === 'string' && label.trim()) return clip(label.trim(), 80)
    } catch {
      // The catalog is optional; the id stands in.
    }
    return `helper ${String(childId).slice(0, 8)}`
  }

  /** Send or edit a chat's status message after a short pause. */
  function schedule(chatId, board) {
    if (board.timer !== undefined) return
    board.timer = setTimeout(() => {
      board.timer = undefined
      void queueOut(chatId, () => publish(chatId, board)).catch((error) => reportError(`helpers in chat ${chatId}`, error))
    }, EDIT_DELAY_MS)
    board.timer.unref?.()
  }

  /** Bring the status message up to date; a finished board is left as it is. */
  async function publish(chatId, board) {
    const runtime = getRuntime()
    if (runtime === undefined) return
    const helpers = [...board.helpers.values()]
    const text = boardText(helpers, now())
    const done = helpers.every((helper) => helper.endedAt !== undefined)
    if (done && boards.get(chatId) === board) boards.delete(chatId)
    if (board.messageId !== undefined) {
      try {
        await runtime.dc.rpc.sendEditRequest(runtime.accountId, board.messageId, text)
        return
      } catch (error) {
        // Without edits the new state goes out as its own message.
        reportError(`editing helper status ${board.messageId}`, error)
      }
    }
    const [messageId] = await sendText(chatId, text, { plain: true })
    board.messageId = messageId
  }

  /**
   * A helper started (`subagent/start`).
   * @param info - `{ runId, id, local }`.
   */
  async function onStart(info) {
    const found = chatOfHelper(info?.id)
    if (found === undefined) return
    const { chatId, sessionId } = found
    const turn = currentTurn(sessionId)
    let board = boards.get(chatId)
    // Helpers show where the session's answers show.
    if (board === undefined && !(turn !== undefined && (turn.ours || turn.goal || turn.mirrored))) return
    if (board === undefined) {
      board = { messageId: undefined, helpers: new Map(), timer: undefined }
      boards.set(chatId, board)
    }
    const parentId = ctx.get('agents')?.get(info.id)?.session?.header?.parentSession ?? sessionId
    const helper = { id: info.id, label: '', model: '', startedAt: now(), endedAt: undefined, stopReason: undefined }
    board.helpers.set(info.runId, helper)
    helper.label = await labelOf(parentId, info.id)
    helper.model = (await sessionModelOf(ctx, info.id).catch(() => undefined))?.model ?? ''
    schedule(chatId, board)
  }

  /**
   * A helper finished (`subagent/end`).
   * @param info - `{ runId, id, stopReason }`.
   */
  function onEnd(info) {
    for (const [chatId, board] of boards) {
      const helper = board.helpers.get(info?.runId)
      if (helper === undefined) continue
      helper.endedAt = now()
      helper.stopReason = info.stopReason
      schedule(chatId, board)
      return
    }
  }

  /**
   * The helpers of a session for `/agents`, newest last, with each one's last report.
   * @param sessionId - the chat's session.
   * @returns `[{ id, label, running, createdAt, report }]`.
   */
  async function list(sessionId) {
    const children = await ctx.get('subagents')?.listChildren(sessionId)
    if (!Array.isArray(children)) return undefined
    const result = []
    for (const child of children.slice(-LIST_LIMIT)) {
      const agent = ctx.get('agents')?.get(child.id)
      const running = agent !== undefined && agent.status !== undefined && agent.status !== 'idle'
      const [report = ''] = await recentAssistantTexts(ctx, child.id, 1)
      result.push({ id: child.id, label: child.label || `helper ${String(child.id).slice(0, 8)}`, running, createdAt: child.createdAt, report })
    }
    return result
  }

  /** Stop pending edits. */
  function dispose() {
    for (const board of boards.values()) if (board.timer !== undefined) clearTimeout(board.timer)
    boards.clear()
  }

  return { onStart, onEnd, list, dispose }
}
