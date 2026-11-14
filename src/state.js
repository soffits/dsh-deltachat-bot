/**
 * Durable bot state: which DSH session each Delta Chat chat is bound to,
 * contacts that wrote without being allowed, and what was sent on behalf of
 * jobs and sessions (so a quoted reply can say where a message came from).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dataDir } from './constants.js'

/** Sent-message records kept for quoted replies. */
const SENT_LIMIT = 500
/** Unknown contacts remembered for the pending list. */
const PENDING_LIMIT = 50

/** @returns an empty state document. */
function emptyState() {
  return { version: 1, chats: {}, pending: {}, sent: [], picks: {} }
}

/**
 * Read a JSON object, or undefined when the file is missing or broken.
 * @param path - file path.
 */
async function readJson(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Open the state file.
 * @param path - defaults to `<data dir>/state.json`.
 * @returns the store.
 */
export async function openState(path = join(dataDir(), 'state.json')) {
  const loaded = await readJson(path)
  const state = { ...emptyState(), ...(loaded ?? {}) }
  for (const key of ['chats', 'pending', 'picks']) {
    if (state[key] === null || typeof state[key] !== 'object' || Array.isArray(state[key])) state[key] = {}
  }
  if (!Array.isArray(state.sent)) state.sent = []
  let writing = Promise.resolve()

  const store = {
    path,
    /** The raw document; mutate through the methods below. */
    get data() {
      return state
    },
    /** Write the document atomically; writes are serialized. */
    save() {
      writing = writing.then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const temporary = `${path}.${process.pid}.tmp`
        await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
        await rename(temporary, path)
      })
      return writing
    },
    /** @returns the binding of a chat, or undefined. */
    chat(chatId) {
      return state.chats[String(chatId)]
    },
    /** @returns the chat id bound to a session, or undefined. */
    chatOfSession(sessionId) {
      for (const [chatId, record] of Object.entries(state.chats)) {
        if (record?.sessionId === sessionId) return Number(chatId)
      }
      return undefined
    },
    /**
     * Bind a chat to a session; a session is shown in one chat at a time, so
     * another chat bound to it loses the binding.
     */
    async bind(chatId, record) {
      for (const [other, entry] of Object.entries(state.chats)) {
        if (other !== String(chatId) && entry?.sessionId === record.sessionId) delete entry.sessionId
      }
      state.chats[String(chatId)] = { ...(state.chats[String(chatId)] ?? {}), ...record, updatedAt: Date.now() }
      await store.save()
    },
    /**
     * Merge fields into a chat's record, saving only when something changed.
     * @returns true when the record changed.
     */
    async describeChat(chatId, fields) {
      const record = state.chats[String(chatId)] ?? {}
      if (Object.entries(fields).every(([key, value]) => record[key] === value)) return false
      state.chats[String(chatId)] = { ...record, ...fields }
      await store.save()
      return true
    },
    /** Forget a chat's session (the chat keeps its other settings). */
    async release(chatId) {
      const record = state.chats[String(chatId)]
      if (record === undefined) return undefined
      const previous = record.sessionId
      delete record.sessionId
      await store.save()
      return previous
    },
    /** Forget a chat entirely (it was deleted or left). */
    async forget(chatId) {
      delete state.chats[String(chatId)]
      await store.save()
    },
    /** Remember a contact that wrote without being allowed. */
    async notePending(entry) {
      const known = state.pending[entry.fingerprint]
      state.pending[entry.fingerprint] = { ...entry, firstSeen: known?.firstSeen ?? Date.now(), lastSeen: Date.now(), count: (known?.count ?? 0) + 1 }
      const keys = Object.keys(state.pending)
      if (keys.length > PENDING_LIMIT) {
        keys.sort((left, right) => state.pending[left].lastSeen - state.pending[right].lastSeen)
        for (const key of keys.slice(0, keys.length - PENDING_LIMIT)) delete state.pending[key]
      }
      await store.save()
      return known === undefined
    },
    /** Drop pending entries that are allowed now. */
    async clearPending(fingerprints) {
      let changed = false
      for (const fingerprint of fingerprints) {
        if (state.pending[fingerprint] === undefined) continue
        delete state.pending[fingerprint]
        changed = true
      }
      if (changed) await store.save()
    },
    /** Record messages sent on someone's behalf. */
    async noteSent(record) {
      state.sent.push({ ...record, at: Date.now() })
      if (state.sent.length > SENT_LIMIT) state.sent.splice(0, state.sent.length - SENT_LIMIT)
      await store.save()
    },
    /** @returns the send record holding a Delta Chat message id, or undefined. */
    sentRecord(messageId) {
      for (let index = state.sent.length - 1; index >= 0; index -= 1) {
        if (state.sent[index].messageIds?.includes(messageId)) return state.sent[index]
      }
      return undefined
    },
  }
  return store
}
