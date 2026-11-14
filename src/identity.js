/**
 * Who a Delta Chat contact is. Delta Chat contacts are identified by their
 * OpenPGP key (addresses can change when someone moves or adds relays), so
 * the allowlist and the sender label use the key fingerprint.
 */
import { createHash } from 'node:crypto'

/**
 * Normalize a fingerprint as typed or shown by Delta Chat ("3C1F 9E0A ...").
 * @param value - fingerprint text.
 * @returns 40 (v4) or 64 (v6) upper-case hex characters, or '' when invalid.
 */
export function normalizeFingerprint(value) {
  const hex = String(value ?? '').replace(/[\s:]/gu, '').toUpperCase()
  return /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/u.test(hex) ? hex : ''
}

/**
 * Read the first OpenPGP packet (the primary public key) of a key block.
 * @param key - binary transferable public key.
 * @returns `{ tag, body }`, or undefined when the data is not a packet.
 */
function firstPacket(key) {
  if (key.length < 2 || (key[0] & 0x80) === 0) return undefined
  const header = key[0]
  let offset = 1
  let length
  let tag
  if ((header & 0x40) !== 0) {
    tag = header & 0x3f
    const first = key[offset++]
    if (first < 192) length = first
    else if (first < 224) length = ((first - 192) << 8) + key[offset++] + 192
    else if (first === 255) {
      length = key.readUInt32BE(offset)
      offset += 4
    } else return undefined
  } else {
    tag = (header >> 2) & 0x0f
    const type = header & 0x03
    if (type === 0) length = key[offset++]
    else if (type === 1) {
      length = key.readUInt16BE(offset)
      offset += 2
    } else if (type === 2) {
      length = key.readUInt32BE(offset)
      offset += 4
    } else return undefined
  }
  if (offset + length > key.length) return undefined
  return { tag, body: key.subarray(offset, offset + length) }
}

/**
 * Fingerprint of an OpenPGP public key (RFC 4880 v4: SHA-1 over 0x99, a
 * two-byte length and the key packet; RFC 9580 v6: SHA-256 over 0x9B, a
 * four-byte length and the packet).
 * @param key - binary transferable public key.
 * @returns the fingerprint in upper-case hex, or '' when it cannot be read.
 */
export function keyFingerprint(key) {
  const packet = firstPacket(key)
  if (packet === undefined || packet.tag !== 6 || packet.body.length === 0) return ''
  const version = packet.body[0]
  if (version === 4) {
    const head = Buffer.from([0x99, (packet.body.length >> 8) & 0xff, packet.body.length & 0xff])
    return createHash('sha1').update(head).update(packet.body).digest('hex').toUpperCase()
  }
  if (version === 6) {
    const head = Buffer.alloc(5)
    head[0] = 0x9b
    head.writeUInt32BE(packet.body.length, 1)
    return createHash('sha256').update(head).update(packet.body).digest('hex').toUpperCase()
  }
  return ''
}

/**
 * Fingerprint of the key a vCard (from `makeVcard`) carries.
 * @param vcard - vCard text.
 * @returns the fingerprint, or '' when the card has no readable key.
 */
export function vcardFingerprint(vcard) {
  const unfolded = String(vcard ?? '').replace(/\r?\n[ \t]/gu, '')
  const match = unfolded.match(/^KEY[^:\n]*:data:application\/pgp-keys;base64\\?,([A-Za-z0-9+/=]+)\s*$/mu)
  if (match === null) return ''
  return keyFingerprint(Buffer.from(match[1], 'base64'))
}

/**
 * Short form of a fingerprint for display: the first and last four groups.
 * @param fingerprint - normalized fingerprint.
 * @returns e.g. `3C1F 9E0A … 8ACE 1357`.
 */
export function shortFingerprint(fingerprint) {
  const groups = String(fingerprint).match(/.{1,4}/gu) ?? []
  if (groups.length <= 4) return groups.join(' ')
  return `${groups.slice(0, 2).join(' ')} … ${groups.slice(-2).join(' ')}`
}

/**
 * Find a fingerprint on the allowlist.
 * @param allowed - configured `{ fingerprint, name }` entries.
 * @param fingerprint - the contact's fingerprint.
 * @returns the entry with its fingerprint normalized, or undefined.
 */
export function allowedEntry(allowed, fingerprint) {
  const wanted = normalizeFingerprint(fingerprint)
  if (wanted === '' || !Array.isArray(allowed)) return undefined
  for (const entry of allowed) {
    if (normalizeFingerprint(entry?.fingerprint) !== wanted) continue
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    return { fingerprint: wanted, name }
  }
  return undefined
}

/**
 * The line that tells the agent who wrote a message. The bot adds it from the
 * sender's verified key, so text inside a message cannot fake it.
 * @param sender - `{ name, fingerprint, displayName, chatId, messageId }`.
 * @returns one bracketed line.
 */
export function senderLine({ name, fingerprint, displayName, chatId, messageId }) {
  // The display name is chosen by the contact; keep it from shaping the line.
  const shown = String(displayName ?? '').replace(/[\[\]"\r\n]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 64)
  const who = name || shown || 'unknown'
  const details = []
  if (shown && shown !== name) details.push(`Delta Chat name "${shown}"`)
  details.push(`key ${fingerprint}`)
  if (Number.isSafeInteger(chatId)) details.push(`chat ${chatId}`)
  if (Number.isSafeInteger(messageId)) details.push(`message ${messageId}`)
  return `[Delta Chat message from ${who} (${details.join(', ')})]`
}
