/**
 * Session titles of chat sessions: `DeltaChat-<person>-<task>`. `person` is
 * who the chat is with (a group's name for a group), `task` the conversation
 * title DSH generates, or the chat's name until there is one. DSH has no title
 * hook, so a generated title is appended again with the prefix and the same
 * source, which keeps automatic titling going.
 */
import { readFileSync, statSync } from 'node:fs'
import { normalizeFingerprint } from './identity.js'

/** Title source marker shared with the other chat bridges' formats. */
export const TITLE_SOURCE = 'DeltaChat'

/** Words taken from the first message when DSH's fallback title is the sender line. */
const FALLBACK_WORDS = 8

/** @returns one line of text, without the separator dashes doubling up. */
function clean(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

/**
 * The full title.
 * @param person - who the chat is with.
 * @param task - conversation title.
 */
export function chatTitle(person, task) {
  return `${TITLE_SOURCE}-${clean(person) || 'unknown'}-${clean(task)}`
}

/**
 * The conversation part of a title, without a `DeltaChat-<person>-` prefix.
 * @param title - current title.
 * @param persons - names the prefix may carry (the current one and earlier ones).
 */
export function taskOf(title, persons) {
  const value = clean(title)
  for (const person of persons) {
    if (person === undefined || person === null) continue
    const prefix = `${TITLE_SOURCE}-${clean(person) || 'unknown'}-`
    if (value.startsWith(prefix)) return value.slice(prefix.length)
  }
  return value
}

/**
 * A conversation title from the first message of a session, used when DSH's
 * fallback title is the bot's sender line.
 * @param events - session events.
 * @returns a few words of the first message's own text, or ''.
 */
export function firstMessageTask(events) {
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') continue
    const text = (event.data.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
    const body = text.split('\n').filter((line) => !/^\[[^\]]*\]$/u.test(line.trim())).join(' ')
    const words = clean(body).split(' ').filter(Boolean)
    if (words.length > 0) return words.slice(0, FALLBACK_WORDS).join(' ')
  }
  return ''
}

/**
 * Names for fingerprints from a JSON file with a `deltachat_keys` object, read
 * again when the file changes.
 * @returns `nameOf(path, fingerprint)`.
 */
export function createPeopleFile() {
  let cached = { path: '', mtime: 0, keys: {} }
  return {
    nameOf(path, fingerprint) {
      if (typeof path !== 'string' || path.length === 0) return undefined
      try {
        const mtime = statSync(path).mtimeMs
        if (cached.path !== path || cached.mtime !== mtime) {
          const parsed = JSON.parse(readFileSync(path, 'utf8'))
          const keys = {}
          for (const [key, name] of Object.entries(parsed?.deltachat_keys ?? {})) {
            const normalized = normalizeFingerprint(key)
            if (normalized && typeof name === 'string') keys[normalized] = name
          }
          cached = { path, mtime, keys }
        }
      } catch {
        return undefined
      }
      return cached.keys[normalizeFingerprint(fingerprint)]
    },
  }
}

/**
 * Keep a bound session's title in the chat format.
 * @param options - `{ service, session, person, earlier, placeholder, previous, warn }`:
 *   the title service, the live session, who the chat is with, names an older
 *   title may carry instead, the task shown before a conversation title
 *   exists, and the placeholder title the bot set earlier (so a renamed chat
 *   moves it).
 * @returns the placeholder title now set by the bot, or `previous`.
 */
export function syncTitle({ service, session, person, earlier = [], placeholder, previous, warn }) {
  if (service === undefined || session === undefined) return previous
  let current
  try {
    current = service.get(session)
  } catch (error) {
    warn?.(`title not read for ${session.id}: ${error?.message ?? error}`)
    return previous
  }
  const placeholderTitle = chatTitle(person, placeholder)
  // A title someone typed stays; only the bot's own placeholder follows the chat.
  if (current === undefined || (current.source?.kind === 'user' && current.title === previous && previous !== placeholderTitle)) {
    service.rename(session, placeholderTitle)
    return placeholderTitle
  }
  if (current.source?.kind === 'user') return previous
  let task = taskOf(current.title, [person, ...earlier])
  if (current.source?.kind === 'fallback' && /^\[Delta Chat message from/u.test(task)) {
    task = firstMessageTask(typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []) || placeholder
  }
  const wanted = chatTitle(person, task)
  if (wanted !== current.title) {
    session.append('session/title', {
      title: wanted,
      messageSeqs: Array.isArray(current.messageSeqs) ? [...current.messageSeqs] : [],
      source: current.source,
    })
  }
  return previous
}

/**
 * Whether a session still shows the bot's placeholder, so its first
 * conversation title should be generated.
 * @param service - title service.
 * @param session - live session.
 * @param previous - the placeholder title the bot set.
 */
export function showsPlaceholder(service, session, previous) {
  try {
    const current = service.get(session)
    return current?.source?.kind === 'user' && current.title === previous
  } catch {
    return false
  }
}
