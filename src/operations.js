/**
 * What the bot offers outside chats: the send service, the chat list, the
 * invite, joining someone's invite, allowing a key, and its status.
 */
import { randomUUID } from 'node:crypto'
import { dataDir, POST_SOURCE_KIND } from './constants.js'
import { allowedEntry, normalizeFingerprint } from './identity.js'
import { finalError } from './outbound.js'
import { recordMessage, resolveAgent } from './sessions.js'
import { clip } from './text.js'

/**
 * The address an invite link names as the profile's primary relay address.
 * @param link - invite link.
 * @returns the address, or undefined.
 */
export function primaryAddress(link) {
  const match = String(link ?? '').match(/[#&]a=([^&]+)/u)
  return match === null ? undefined : decodeURIComponent(match[1].replace(/\+/gu, ' '))
}

/**
 * Create the operations.
 * @param deps - `{ ctx, getStore, storeReady, requireRuntime, getRuntime, getStatus, setting, outbound, currentTurn, writeInvite, info, reportError, messageOf }`.
 */
export function createOperations({ ctx, getStore, storeReady, requireRuntime, getRuntime, getStatus, setting, outbound, currentTurn, writeInvite, info, reportError, messageOf }) {
  const { queueOut, sendText, sendFiles, checkFiles } = outbound

  /**
   * Send text, files or a reaction into a chat on behalf of a job, a session
   * or a command, and record it in the session bound to that chat.
   * @param request - `{ to, text, files, from, replyTo, reaction }`: `to` is
   *   the chat id; `from` `{ job, sessionId, label }` names the sender;
   *   `replyTo` quotes a message; `reaction` reacts to `replyTo` instead of
   *   sending text.
   * @returns where it went and whether the session recorded it.
   */
  async function sendToChat(request) {
    await storeReady
    const store = getStore()
    const { dc, accountId } = requireRuntime()
    const chatId = Number(request?.to)
    if (!Number.isSafeInteger(chatId) || chatId <= 9) throw finalError(`Unknown chat ${request?.to}; /id in a chat shows its id.`)
    const chatInfo = await dc.rpc.getBasicChatInfo(accountId, chatId).catch(() => undefined)
    if (chatInfo === undefined || chatInfo.isDeviceChat) throw finalError(`Unknown chat ${chatId}; /id in a chat shows its id.`)
    const replyTo = request?.replyTo === undefined || request?.replyTo === null ? undefined : Number(request.replyTo)
    if (typeof request?.reaction === 'string') {
      if (!Number.isSafeInteger(replyTo)) throw finalError('A reaction needs replyTo: the message id to react to.')
      await dc.rpc.sendReaction(accountId, replyTo, request.reaction.length === 0 ? [] : [request.reaction])
      return { chatId, reacted: replyTo }
    }
    const text = typeof request?.text === 'string' ? request.text.trim() : ''
    const paths = Array.isArray(request?.files) ? request.files.map(String) : []
    if (text.length === 0 && paths.length === 0) throw finalError('Nothing to send: give text or files.')
    const files = await checkFiles(paths)
    const messageIds = await queueOut(chatId, async () => {
      const ids = text.length > 0 ? await sendText(chatId, text, { quote: replyTo }) : []
      ids.push(...await sendFiles(chatId, files))
      return ids
    })
    const from = request?.from ?? {}
    const sessionId = store.chat(chatId)?.sessionId
    const ownTurn = typeof from.sessionId === 'string' && from.sessionId === sessionId ? currentTurn(sessionId) : undefined
    if (ownTurn !== undefined) ownTurn.sent = true
    await store.noteSent({
      chatId,
      messageIds,
      text,
      files: files.map((file) => file.name),
      job: typeof from.job === 'string' && from.job.trim() ? from.job.trim() : null,
      fromSession: typeof from.sessionId === 'string' ? from.sessionId : null,
      label: typeof from.label === 'string' ? from.label : null,
    })
    let recorded = false
    let recordError
    if (typeof sessionId === 'string') {
      try {
        const agent = await resolveAgent(ctx, sessionId)
        const self = sessionId === from.sessionId
        const by = self ? ' by this session' : from.job ? ` by job "${from.job}"` : from.sessionId ? ` by session ${from.sessionId}` : from.label ? ` by ${from.label}` : ''
        const header = `Sent to Delta Chat chat "${chatInfo.name}"${by}`
        const content = [{ type: 'text', text: `[${header}]${text ? `\n${text}` : ''}${files.length > 0 ? `\n[Files: ${files.map((file) => file.name).join(', ')}]` : ''}` }]
        recordMessage(agent, { id: randomUUID(), role: 'user', content, source: { kind: POST_SOURCE_KIND, form: 'notice', summary: clip(header, 120), chatId, self } })
        recorded = true
      } catch (error) {
        recordError = messageOf(error)
        reportError('send-record', error)
      }
    }
    return { chatId, chat: chatInfo.name, messageIds, sessionId: sessionId ?? null, recorded, ...(recordError ? { recordError } : {}) }
  }

  /** Known chats: every chat bound to a session, with its name. */
  async function listChats() {
    await storeReady
    const store = getStore()
    const { dc, accountId } = requireRuntime()
    const result = []
    for (const [chatId, record] of Object.entries(store.data.chats)) {
      const chatInfo = await dc.rpc.getBasicChatInfo(accountId, Number(chatId)).catch(() => undefined)
      if (chatInfo === undefined) continue
      result.push({ chatId: Number(chatId), name: chatInfo.name, type: chatInfo.chatType, sessionId: record.sessionId ?? null })
    }
    return result
  }

  /** The bot's invite link and QR code file. */
  async function invite() {
    const { dc, accountId } = requireRuntime()
    return writeInvite(dc, accountId, dataDir())
  }

  /** Secure-join someone's invite link (a contact or a group). */
  async function joinInvite(link) {
    const { dc, accountId } = requireRuntime()
    const checked = await dc.rpc.checkQr(accountId, link)
    if (!['askVerifyContact', 'askVerifyGroup', 'askJoinBroadcast'].includes(checked?.kind)) {
      throw finalError(`Not an invite link (${checked?.kind ?? 'unknown'}).`)
    }
    const fingerprint = normalizeFingerprint(checked.fingerprint)
    const allowed = allowedEntry(setting('allowedUsers', []), fingerprint)
    if (allowed === undefined) {
      throw finalError(`The invite belongs to key ${fingerprint || 'unknown'}, which is not in allowedUsers. Add it first.`)
    }
    const chatId = await dc.rpc.secureJoin(accountId, link)
    info(`joining ${allowed.name || fingerprint} through their invite (chat ${chatId})`)
    return { chatId, name: allowed.name, fingerprint }
  }

  /**
   * Add someone to `allowedUsers` through the Host's config editor, which
   * writes the profile's patch the same way the settings page does.
   * @param fingerprint - their key fingerprint.
   * @param label - how their messages are labelled.
   */
  async function allowUser(fingerprint, label) {
    const normalized = normalizeFingerprint(fingerprint)
    if (normalized === '') throw finalError('A key fingerprint has 40 hex characters.')
    const entry = ctx.fiber?.entry
    const editor = ctx.get('configEditor')
    if (entry === undefined || editor === undefined) throw new Error('This profile cannot save the bot\'s configuration; add the fingerprint to allowedUsers by hand.')
    await editor.edit(entry, (current) => {
      const list = Array.isArray(current?.allowedUsers) ? current.allowedUsers.filter((item) => normalizeFingerprint(item?.fingerprint) !== normalized) : []
      return { ...current, allowedUsers: [...list, { fingerprint: normalized, name: String(label ?? '').trim() }] }
    })
    await storeReady
    await getStore().clearPending([normalized])
    return { fingerprint: normalized, name: String(label ?? '').trim() }
  }

  /** Runtime facts for `/status` and the command line. */
  async function describe() {
    await storeReady
    const store = getStore()
    const runtime = getRuntime()
    if (runtime === undefined) return { running: false, state: getStatus().state, detail: getStatus().detail ?? '' }
    const { dc, accountId, startedAt } = runtime
    const transports = await dc.rpc.listTransports(accountId).catch(() => [])
    const connectivity = await dc.rpc.getConnectivity(accountId).catch(() => undefined)
    const selfAddr = primaryAddress(await dc.rpc.getChatSecurejoinQrCode(accountId, null).catch(() => '')) ?? transports[0]?.addr ?? null
    return {
      running: true,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      primary: selfAddr,
      relays: transports.map((transport) => transport.addr),
      connectivity,
      allowedUsers: setting('allowedUsers', []).length,
      pending: Object.values(store.data.pending).map((entry) => ({ fingerprint: entry.fingerprint, displayName: entry.displayName, lastSeen: new Date(entry.lastSeen).toISOString(), count: entry.count })),
      chats: Object.keys(store.data.chats).length,
    }
  }

  return { sendToChat, listChats, invite, joinInvite, allowUser, describe }
}
