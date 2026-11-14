/**
 * Turn one incoming Delta Chat message into a DSH prompt: the sender line,
 * what it quotes, its text, and its file as an attachment (pictures as
 * images, recordings transcribed).
 */
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { MAX_FILE_BYTES } from './constants.js'
import { senderLine } from './identity.js'
import { clip } from './text.js'
import { transcribe, transcriptNote } from './voice.js'

/** Longest quoted text passed to the agent. */
const QUOTE_LIMIT = 2000
/** Longest text of a message sent on someone's behalf passed to the agent. */
const SENT_TEXT_LIMIT = 8000
/** Image types the DSH attachment store takes as pictures. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/**
 * Describe what a message quotes.
 * @param quote - `msg.quote`.
 * @param context - `{ quotedOwn, sentRecord }`: whether the quoted message is
 *   the bot's own and the send record it belongs to.
 * @returns a context block, or undefined.
 */
export function describeQuote(quote, { quotedOwn, sentRecord } = {}) {
  if (quote === null || quote === undefined) return undefined
  const text = clip(quote.text ?? '', QUOTE_LIMIT)
  if (quote.kind !== 'WithMessage') return `[Quoting:]\n${text}`
  if (quotedOwn) {
    if (sentRecord !== undefined) {
      const by = sentRecord.job ? `job "${sentRecord.job}"` : sentRecord.fromSession ? `session ${sentRecord.fromSession}` : sentRecord.label || 'another sender'
      const full = typeof sentRecord.text === 'string' && sentRecord.text.length > 0 ? clip(sentRecord.text, SENT_TEXT_LIMIT) : text
      return `[Replying to a message ${by} sent here:]\n${full}`
    }
    return `[Replying to your earlier message:]\n${text}`
  }
  const author = quote.overrideSenderName || quote.authorDisplayName || 'someone'
  return `[Replying to ${author}:]\n${text}`
}

/** Delta Chat view types that carry speech. */
const SPOKEN = { Voice: 'voice message', Audio: 'audio file' }

/**
 * Build the prompt for one message.
 * @param msg - Delta Chat message (`getMessage`).
 * @param options - `{ sender, chatId, quotedOwn, sentRecord, attachments, voice, signal, warn }`:
 *   `sender` is `{ name, fingerprint, displayName }`; `attachments` the DSH
 *   attachment store; `voice` `{ mode, language, command, ffmpeg, speech }`.
 * @returns `{ text, attachments }`.
 */
export async function composePrompt(msg, options) {
  const { sender, chatId, attachments: store, voice, signal, warn } = options
  const lines = [senderLine({ ...sender, chatId, messageId: msg.id })]
  if (msg.isForwarded) lines.push('[Forwarded message]')
  const quote = describeQuote(msg.quote, options)
  if (quote !== undefined) lines.push(quote)
  const blocks = []
  if (typeof msg.file === 'string' && msg.file.length > 0) {
    const name = msg.fileName || basename(msg.file)
    const size = msg.fileBytes ?? (await stat(msg.file).catch(() => undefined))?.size ?? 0
    const spoken = SPOKEN[msg.viewType]
    if (spoken !== undefined && voice.mode !== 'off') {
      const media = { kind: spoken, name, seconds: msg.duration > 0 ? Math.round(msg.duration / 1000) : undefined }
      try {
        const result = await transcribe({ ...voice, path: msg.file, signal })
        lines.push(transcriptNote(media, { ...result, path: msg.file }))
      } catch (error) {
        lines.push(transcriptNote(media, { path: msg.file, error: error?.message ?? String(error) }))
      }
    } else if (size > MAX_FILE_BYTES) {
      lines.push(`[File "${name}" (${size} bytes) is too large to attach; it is saved at ${msg.file}]`)
    } else {
      lines.push(`[${msg.viewType === 'Image' || msg.viewType === 'Gif' || msg.viewType === 'Sticker' ? 'Picture' : 'File'} "${name}", saved at ${msg.file}]`)
    }
    if (size <= MAX_FILE_BYTES && store !== undefined) {
      try {
        const data = await readFile(msg.file)
        const mediaType = String(msg.fileMime ?? '').toLowerCase()
        let block
        if (IMAGE_TYPES.has(mediaType)) {
          try {
            block = { type: 'image', attachment: await store.saveImage({ data, mediaType, name }) }
          } catch (error) {
            warn?.(`${name} kept as a file, not an image: ${error?.message ?? error}`)
          }
        }
        block ??= { type: 'file', attachment: await store.saveFile({ data, name }) }
        blocks.push(block)
      } catch (error) {
        warn?.(`${name} not attached: ${error?.message ?? error}`)
      }
    }
  }
  const body = String(msg.text ?? '').trim()
  if (body.length > 0) lines.push(body)
  return { text: lines.join('\n'), attachments: blocks }
}
