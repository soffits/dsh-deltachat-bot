/**
 * Approval requests and agent questions for turns started from Delta Chat.
 * Delta Chat has no buttons, so a question lists its options as numbers and
 * the next message answers it; an approval waits for /allow or /deny.
 */
import { randomUUID } from 'node:crypto'

/**
 * Parse a reply to a question with options.
 * @param text - the reply.
 * @param question - `{ options, multiSelect }`.
 * @returns `{ selected, custom }`: option labels picked by number, or the
 *   whole reply as a free answer.
 */
export function parseAnswer(text, question) {
  const options = Array.isArray(question?.options) ? question.options : []
  const trimmed = String(text ?? '').trim()
  if (options.length > 0 && /^\d+(?:[\s,]+\d+)*$/u.test(trimmed)) {
    const numbers = trimmed.split(/[\s,]+/u).map(Number)
    if (numbers.every((number) => number >= 1 && number <= options.length)) {
      const picked = [...new Set(numbers)].map((number) => options[number - 1].label)
      return { selected: question.multiSelect === true ? picked : picked.slice(0, 1), custom: undefined }
    }
  }
  return { selected: [], custom: trimmed }
}

/**
 * Text of one question.
 * @param question - user question.
 * @param index - its position.
 * @param total - questions in the batch.
 */
export function questionText(question, index, total) {
  const lines = []
  if (question.header) lines.push(question.header)
  lines.push(`❓ ${question.question}`)
  if (question.detail) lines.push('', String(question.detail).slice(0, 3000))
  const options = Array.isArray(question.options) ? question.options : []
  if (options.length > 0) {
    lines.push('')
    for (const [number, option] of options.entries()) {
      lines.push(`${number + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`)
    }
    lines.push('', question.multiSelect === true
      ? 'Reply with one or more numbers (like "1 3"), or write your own answer.'
      : 'Reply with a number, or write your own answer.')
  } else {
    lines.push('', 'Reply with your answer.')
  }
  if (total > 1) lines.push(`(Question ${index + 1} of ${total}; /stop cancels.)`)
  return lines.join('\n')
}

/**
 * Create the prompt broker.
 * @param options - `{ chatOfAgent, send, warn }`: `chatOfAgent(agent)` gives
 *   the chat that should answer for a turn, or undefined to leave it to DSH.
 * @returns `{ attach, consumeReply, settleApproval, cancelChat, cancelAll, pending }`.
 */
export function createPrompts({ chatOfAgent, send, warn }) {
  const attached = new WeakSet()
  /** Pending question batches by chat id. */
  const questions = new Map()
  /** Pending approvals by chat id (a list, oldest first). */
  const approvals = new Map()

  function finishQuestion(chatId, batch, error) {
    if (questions.get(chatId) !== batch) return
    questions.delete(chatId)
    batch.signal?.removeEventListener('abort', batch.onAbort)
    if (error === undefined) batch.resolve({ answers: batch.answers })
    else batch.reject(error)
  }

  async function askQuestions(chatId, req, next) {
    const list = Array.isArray(req.questions) ? req.questions : []
    if (list.length === 0 || questions.has(chatId)) return next()
    const signal = req.signal
    if (signal?.aborted) return next()
    return new Promise((resolve, reject) => {
      const batch = { id: randomUUID(), questions: list, index: 0, answers: [], resolve, reject, signal, onAbort: undefined }
      batch.onAbort = () => {
        finishQuestion(chatId, batch, signal.reason ?? new Error('question cancelled'))
        void send(chatId, '⏹ Question cancelled.')
      }
      signal?.addEventListener('abort', batch.onAbort, { once: true })
      questions.set(chatId, batch)
      Promise.resolve(send(chatId, questionText(list[0], 0, list.length))).catch((error) => {
        warn(`question not sent: ${error?.message ?? error}`)
        finishQuestion(chatId, batch, error)
      })
    })
  }

  async function askApproval(chatId, req) {
    if (req.signal?.aborted) return 'cancelled'
    const reason = req.displayReason?.en ?? req.reason ?? 'The tool asked for approval.'
    return new Promise((resolve) => {
      const entry = { resolve, toolName: req.toolName, signal: req.signal, onAbort: undefined }
      entry.onAbort = () => settle(chatId, entry, 'cancelled')
      req.signal?.addEventListener('abort', entry.onAbort, { once: true })
      const list = approvals.get(chatId) ?? []
      list.push(entry)
      approvals.set(chatId, list)
      Promise.resolve(send(chatId, `🔐 Approval needed for ${req.toolName}:\n${reason}\n\nReply /allow or /deny.`)).catch(() => settle(chatId, entry, 'unavailable'))
    })
  }

  function settle(chatId, entry, outcome) {
    const list = approvals.get(chatId) ?? []
    const index = list.indexOf(entry)
    if (index === -1) return false
    list.splice(index, 1)
    if (list.length === 0) approvals.delete(chatId)
    entry.signal?.removeEventListener('abort', entry.onAbort)
    entry.resolve(outcome)
    return true
  }

  return {
    /** Answer approval and question requests of an agent while its turn belongs to a chat. */
    attach(agent) {
      if (attached.has(agent) || typeof agent?.ctx?.on !== 'function') return
      attached.add(agent)
      agent.ctx.on('approval/request', (req, next) => {
        const chatId = chatOfAgent(agent)
        if (chatId === undefined) return next()
        return askApproval(chatId, req)
      }, { prepend: true })
      agent.ctx.on('user-questions/request', (req, next) => {
        const chatId = chatOfAgent(agent)
        if (chatId === undefined) return next()
        return askQuestions(chatId, req, next)
      }, { prepend: true })
    },
    /**
     * Take a message as the answer to the chat's open question.
     * @returns true when the message answered a question.
     */
    consumeReply(chatId, text) {
      const batch = questions.get(chatId)
      if (batch === undefined || text.length === 0 || text.startsWith('/')) return false
      const question = batch.questions[batch.index]
      const { selected, custom } = parseAnswer(text, question)
      batch.answers.push({ id: question.id, selected, ...(custom ? { custom } : {}) })
      batch.index += 1
      if (batch.index < batch.questions.length) {
        void send(chatId, questionText(batch.questions[batch.index], batch.index, batch.questions.length))
      } else {
        finishQuestion(chatId, batch)
      }
      return true
    },
    /**
     * Resolve the oldest approval of a chat.
     * @returns the tool name, or undefined when none was waiting.
     */
    settleApproval(chatId, allowed) {
      const entry = approvals.get(chatId)?.[0]
      if (entry === undefined) return undefined
      settle(chatId, entry, allowed ? 'allowed-once' : 'rejected')
      return entry.toolName
    },
    /** Cancel what a chat was asked (on /stop). */
    cancelChat(chatId) {
      const batch = questions.get(chatId)
      if (batch !== undefined) finishQuestion(chatId, batch, new Error('Question cancelled by /stop'))
      for (const entry of [...(approvals.get(chatId) ?? [])]) settle(chatId, entry, 'cancelled')
    },
    cancelAll() {
      for (const chatId of [...questions.keys(), ...approvals.keys()]) this.cancelChat(chatId)
    },
    /** @returns what a chat is being asked: `{ question, approvals }`. */
    pending(chatId) {
      return { question: questions.has(chatId), approvals: approvals.get(chatId)?.length ?? 0 }
    },
  }
}
