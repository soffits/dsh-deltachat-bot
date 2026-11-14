/** Sending into chats: text made plain and split, files, notices, in order per chat. */
import { stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { MAX_FILE_BYTES } from './constants.js'
import { messageData, viewTypeOf } from './core.js'
import { splitText, toPlainText } from './text.js'

/** An error that a retry will not fix. */
export function finalError(message) {
  return Object.assign(new Error(message), { retryable: false })
}

/**
 * Create the sender.
 * @param deps - `{ requireRuntime, chatState, reportError, messageOf }`.
 * @returns `{ queueOut, sendText, checkFiles, sendFiles, notice }`.
 */
export function createOutbound({ requireRuntime, chatState, reportError, messageOf }) {
/** Run output for a chat in order. */
  function queueOut(chatId, task) {
    const chat = chatState(chatId)
    const run = chat.out.catch(() => {}).then(task)
    chat.out = run.catch((error) => reportError('send', error))
    return run
  }

  // ---------------------------------------------------------------- outbound

  /**
   * Send text (Markdown is made plain) into a chat.
   * @param chatId - chat id.
   * @param text - Markdown text.
   * @param options - `{ quote, plain }`: message id to quote on the first part;
   *   `plain` skips the Markdown conversion.
   * @returns the sent message ids.
   */
  async function sendText(chatId, text, { quote, plain = false } = {}) {
    const { dc, accountId } = requireRuntime()
    const ids = []
    for (const [index, part] of splitText(plain ? text : toPlainText(text)).entries()) {
      ids.push(await dc.rpc.sendMsg(accountId, chatId, messageData({ text: part, ...(index === 0 && Number.isSafeInteger(quote) ? { quotedMessageId: quote } : {}) })))
    }
    return ids
  }

  /**
   * Check files before anything is sent.
   * @param paths - absolute paths.
   * @returns `{ path, name, size }` entries; throws on the first bad one.
   */
  async function checkFiles(paths) {
    const files = []
    for (const path of paths) {
      if (!isAbsolute(path)) throw finalError(`File paths must be absolute: ${path}`)
      const info = await stat(path).catch((error) => { throw finalError(`${path}: ${messageOf(error)}`) })
      if (!info.isFile()) throw finalError(`${path} is not a file`)
      if (info.size > MAX_FILE_BYTES) throw finalError(`${path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`)
      files.push({ path, name: basename(path), size: info.size })
    }
    return files
  }

  /** Send checked files; the core copies each into its blob directory. */
  async function sendFiles(chatId, files) {
    const { dc, accountId } = requireRuntime()
    const ids = []
    for (const file of files) {
      ids.push(await dc.rpc.sendMsg(accountId, chatId, messageData({ file: file.path, filename: file.name, viewtype: viewTypeOf(file.path) })))
    }
    return ids
  }

  /** A short bot notice (already plain text) into a chat. */
  function notice(chatId, text) {
    return queueOut(chatId, () => sendText(chatId, text, { plain: true }))
  }

  return { queueOut, sendText, checkFiles, sendFiles, notice }
}
