/**
 * Text going between DSH and Delta Chat: the answer a turn leaves, Markdown
 * turned into readable plain text (Delta Chat apps show messages as plain
 * text), splitting, and the silent marker.
 */
import { MAX_MESSAGE_TEXT, SILENT_REPLY } from './constants.js'

/**
 * The answer one assistant message holds: the last text block of a message
 * that called no tool. Text written between tool calls is working narration,
 * not part of the answer; a message that called a tool is mid-chain.
 * @param message - an assistant message (`{ content: [...] }`).
 * @returns the answer, or '' when the message holds none.
 */
export function messageAnswer(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  if (content.some((block) => block?.type === 'tool-call')) return ''
  const texts = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
  return texts.at(-1) ?? ''
}

/**
 * Remove the silent marker from the end of an answer.
 * @param text - final answer.
 * @returns `{ text, silent }`: the rest of the text and whether the marker was there.
 */
export function stripSilent(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.endsWith(SILENT_REPLY)) return { text: trimmed, silent: false }
  return { text: trimmed.slice(0, -SILENT_REPLY.length).trim(), silent: true }
}

/**
 * Local image paths a Markdown answer shows inline (`![alt](/abs/path)` or a
 * `file://` URL), outside code. Delta Chat cannot show them inline, so they
 * are sent as files after the text.
 * @param markdown - answer text.
 * @returns absolute paths, without duplicates.
 */
export function localImagePaths(markdown) {
  const found = []
  const pattern = /!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/gu
  let fenced = false
  for (const line of String(markdown ?? '').split('\n')) {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    for (const match of line.split(/`[^`]*`/gu).join(' ').matchAll(pattern)) {
      let target = (match[1] ?? match[2]).trim()
      if (/^file:\/\//iu.test(target)) {
        try {
          target = decodeURIComponent(new URL(target).pathname)
        } catch {
          continue
        }
      }
      if (target.startsWith('/') && !found.includes(target)) found.push(target)
    }
  }
  return found
}

/**
 * Inline Markdown of one line as plain text.
 * @param line - text outside code fences.
 * @returns the line without emphasis markers, with links spelled out.
 */
function plainInline(line) {
  // Keep inline code as it is, without its backticks.
  const parts = line.split(/(`[^`\n]+`)/gu)
  return parts.map((part, index) => {
    if (index % 2 === 1) return part.slice(1, -1)
    let text = part
    // Images: local ones are sent as files, remote ones keep their address.
    text = text.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu, (_all, alt, target) => {
      if (target.startsWith('/') || /^file:\/\//iu.test(target)) return alt.trim().length > 0 ? `[${alt.trim()}]` : ''
      return alt.trim().length > 0 ? `${alt.trim()} (${target})` : target
    })
    text = text.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu, (_all, label, target) => {
      const shown = label.trim()
      return shown === target || shown === target.replace(/^mailto:/u, '') ? target : `${shown} (${target})`
    })
    text = text.replace(/<(https?:\/\/[^>\s]+)>/gu, '$1')
    text = text.replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/gu, '$2')
    text = text.replace(/(^|[\s(])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?=$|[\s).,!?:;])/gu, '$1$2')
    text = text.replace(/(^|[\s(])_(?=[^\s_])([^_\n]*?[^\s_])_(?=$|[\s).,!?:;])/gu, '$1$2')
    text = text.replace(/~~(?=\S)([^\n]*?\S)~~/gu, '$1')
    return text
  }).join('')
}

/**
 * Turn a Markdown answer into plain text that reads well in Delta Chat:
 * emphasis markers and fence lines go, headings become plain lines, bullets
 * become dots, links show their address, tables become rows of cells. Text
 * inside code fences is kept exactly.
 * @param markdown - answer text.
 * @returns plain text.
 */
export function toPlainText(markdown) {
  const out = []
  let fenced = false
  for (const raw of String(markdown ?? '').replace(/\r\n/gu, '\n').split('\n')) {
    if (/^\s*(```|~~~)/u.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      out.push(raw)
      continue
    }
    let line = raw
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/u.test(line) && line.includes('|')) continue
    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line)) {
      out.push('—')
      continue
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/u)
    if (heading !== null) {
      out.push(plainInline(heading[1]))
      continue
    }
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((cell) => plainInline(cell.trim()))
      out.push(cells.join(' · '))
      continue
    }
    line = line.replace(/^(\s*)[-*+]\s+\[( |x|X)\]\s+/u, (_all, indent, mark) => `${indent}${mark === ' ' ? '☐' : '☑'} `)
    line = line.replace(/^(\s*)[-*+]\s+/u, '$1• ')
    out.push(plainInline(line))
  }
  return out.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/**
 * Split text into messages no longer than the limit, preferring paragraph,
 * then line, then word boundaries.
 * @param text - plain text.
 * @param limit - longest message.
 * @returns non-empty parts.
 */
export function splitText(text, limit = MAX_MESSAGE_TEXT) {
  const parts = []
  let rest = String(text ?? '').trim()
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf('\n\n')
    if (cut < limit / 2) cut = window.lastIndexOf('\n')
    if (cut < limit / 2) cut = window.lastIndexOf(' ')
    if (cut < limit / 2) cut = limit
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) parts.push(rest)
  return parts
}

/**
 * Cut a preview to a length, on a word boundary when one is near.
 * @param text - any text.
 * @param max - longest result.
 * @returns the preview, with an ellipsis when cut.
 */
export function clip(text, max) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  const cut = value.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`
}
