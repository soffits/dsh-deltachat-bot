/** Host runtime: the Delta Chat profile, incoming messages and the wiring of the parts. */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCommand, runCommand } from './commands.js'
import { accountsDir, dataDir, name, POST_SOURCE_KIND, REQUEST_PREFIX, SERVICE_NAME, STEER_REACTION } from './constants.js'
import * as realCore from './core.js'
import { allowedEntry, normalizeFingerprint, shortFingerprint } from './identity.js'
import { composePrompt } from './inbound.js'
import { createModelCatalog } from './models.js'
import { createOperations, primaryAddress } from './operations.js'
import { createOutbound } from './outbound.js'
import { createPrompts } from './prompts.js'
import { admitPrompt, createSession, recordMessage, resolveAgent, unarchive } from './sessions.js'
import { createSpool } from './spool.js'
import { openState } from './state.js'
import { clip } from './text.js'
import { createTurns } from './turns.js'
import { createPeopleFile, showsPlaceholder, syncTitle } from './titles.js'

/**
 * Read a Config field that may be a plain value or a volatile reference.
 * @param value - Config field.
 * @param fallback - value used when the field is absent.
 */
export function readLive(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      const current = value.get()
      return current === undefined ? fallback : current
    } catch {
      return fallback
    }
  }
  return value === undefined || value === null ? fallback : value
}

/** @returns a short message for any thrown value. */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error?.message ?? error)
}

/** Delta Chat's id for the bot's own contact. */
const SELF_CONTACT = 1
/** Shortest and longest pause before the profile is started again after a failure. */
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

/**
 * Mount the bot.
 * @param ctx - Host plugin context.
 * @param config - live plugin configuration.
 */
export function apply(ctx, config) {
  createBridge(ctx, config, realCore)
}

/**
 * The bot with its Delta Chat side passed in, so tests can drive it with a
 * fake core.
 * @param ctx - Host plugin context.
 * @param config - live plugin configuration.
 * @param core - `{ startServer, ensureAccount, createFingerprints, startWatchdog, writeInvite }`.
 */
export function createBridge(ctx, config, core) {
  const { createFingerprints, ensureAccount, startServer, startWatchdog, writeInvite } = core
  // The Host keeps no plugin logger output, so lines also go to the process's
  // own output, which is where an operator reads DSH's log.
  const logger = typeof ctx.logger === 'function' ? ctx.logger('deltachat') : ctx.logger
  const info = (message) => {
    logger?.info?.(message)
    if (process.env.NODE_ENV !== 'test') console.log(`[dsh-deltachat-bot] ${message}`)
  }
  const warn = (message) => {
    logger?.warn?.(message)
    if (process.env.NODE_ENV !== 'test') console.error(`[dsh-deltachat-bot] ${message}`)
  }
  const setting = (field, fallback) => readLive(config[field], fallback)
  const lifetime = new AbortController()

  /** Running profile: `{ dc, accountId, close, stopWatchdog, fingerprints, startedAt }`. */
  let runtime
  let starting
  let retryTimer
  let retryDelay = RETRY_MIN_MS
  let disposed = false
  let store
  const storeReady = openState().then((opened) => { store = opened })
  /** Live per-chat state by chat id. */
  const chats = new Map()
  /** Message ids being handled, so a message seen twice at start is handled once. */
  const handling = new Set()
  const modelCatalog = createModelCatalog(ctx)
  let status = { state: 'starting', updatedAt: new Date().toISOString() }

  async function publishStatus(patch) {
    status = { ...status, ...patch, updatedAt: new Date().toISOString() }
    try {
      await mkdir(dataDir(), { recursive: true, mode: 0o700 })
      await writeFile(join(dataDir(), 'status.json'), JSON.stringify(status, null, 2) + '\n', { mode: 0o600 })
    } catch {
      // Diagnostics never take the runtime down.
    }
  }

  function reportError(scope, error) {
    warn(`${scope}: ${messageOf(error)}`)
    void publishStatus({ lastError: { scope, detail: messageOf(error), at: new Date().toISOString() } })
  }

  function fireAndForget(scope, task) {
    Promise.resolve().then(task).catch((error) => reportError(scope, error))
  }

  /** @returns the live state of one chat. */
  function chatState(chatId) {
    let chat = chats.get(chatId)
    if (chat === undefined) {
      chat = { chatId, out: Promise.resolve(), lastInbound: undefined, admission: undefined, stopping: false }
      chats.set(chatId, chat)
    }
    return chat
  }

  function requireRuntime() {
    if (runtime === undefined) throw new Error('The Delta Chat bot is not running.')
    return runtime
  }

  const outbound = createOutbound({ requireRuntime, chatState, reportError, messageOf })
  const { notice, sendText } = outbound
  const turns = createTurns({
    ctx,
    getStore: () => store,
    isRunning: () => runtime !== undefined,
    setting,
    outbound,
    chatState,
    publishStatus,
    fireAndForget,
    messageOf,
  })
  const { currentTurn } = turns
  const operations = createOperations({
    ctx,
    getStore: () => store,
    storeReady,
    requireRuntime,
    getRuntime: () => runtime,
    getStatus: () => status,
    setting,
    outbound,
    currentTurn,
    writeInvite,
    info,
    reportError,
    messageOf,
  })
  const { sendToChat, listChats, invite, joinInvite, allowUser, describe } = operations

  // ---------------------------------------------------------------- sessions

  /**
   * The live agent of a chat's session, creating the session when the chat
   * has none.
   * @param chatId - chat id.
   * @param options - `{ claim }`: end the blank state of a new session at once.
   */
  async function ensureAgent(chatId, { claim = false } = {}) {
    await storeReady
    const record = store.chat(chatId)
    if (typeof record?.sessionId === 'string') {
      try {
        const agent = await resolveAgent(ctx, record.sessionId)
        prompts.attach(agent)
        return agent
      } catch (error) {
        warn(`session ${record.sessionId} of chat ${chatId} could not be resumed, starting a new one: ${messageOf(error)}`)
        await store.release(chatId)
      }
    }
    const cwd = record?.cwd ?? setting('cwd', process.cwd())
    const preset = String(setting('agentPreset', '')).trim() || undefined
    const model = store.data.picks[String(chatId)]
    const agent = await createSession(ctx, { cwd, preset, model, chatId, claim, warn })
    const sessionId = agent.session?.id ?? agent.id
    await store.bind(chatId, { sessionId, cwd })
    await applyTitle(sessionId)
    prompts.attach(agent)
    info(`chat ${chatId} now uses session ${sessionId}`)
    return agent
  }

  // ------------------------------------------------------------------ titles

  const peopleFile = createPeopleFile()
  /** Sessions whose first conversation title is being generated. */
  const titleRequests = new Set()

  /**
   * Remember who a chat is with, for its session's title: a group's name, or
   * the person's name from `peopleFile`, the allowlist or their own profile.
   * A change moves the title of the chat's session.
   */
  async function noteChatIdentity(chatId, chatInfo, sender) {
    const group = chatInfo.chatType !== 'Single'
    const person = group
      ? chatInfo.name
      : peopleFile.nameOf(setting('peopleFile', ''), sender.fingerprint) || sender.name || sender.displayName || chatInfo.name
    if (await store.describeChat(chatId, { person, chatName: chatInfo.name })) {
      const sessionId = store.chat(chatId)?.sessionId
      if (typeof sessionId === 'string') await applyTitle(sessionId)
    }
  }

  /** Bring a bound session's title to `DeltaChat-<person>-<task>`. */
  async function applyTitle(sessionId) {
    const chatId = store?.chatOfSession(sessionId)
    const record = chatId === undefined ? undefined : store.chat(chatId)
    const session = ctx.get('agents')?.get(sessionId)?.session
    if (record === undefined || session === undefined) return
    try {
      const person = record.person ?? record.chatName ?? String(chatId)
      const placeholder = syncTitle({
        service: ctx.get('sessionTitle'),
        session,
        person,
        earlier: record.titlePersons ?? [],
        placeholder: record.chatName ?? String(chatId),
        previous: record.placeholderTitle,
        warn,
      })
      const titlePersons = [person, ...(record.titlePersons ?? []).filter((name) => name !== person)].slice(0, 5)
      await store.describeChat(chatId, { placeholderTitle: placeholder, titlePersons })
    } catch (error) {
      warn(`title of ${sessionId} not set: ${messageOf(error)}`)
    }
  }

  /**
   * Ask DSH for a session's first conversation title once it has a prompt and
   * a model route, while it still shows the bot's placeholder: the placeholder
   * is a user title, which stops automatic titling.
   */
  function startTitle(sessionId) {
    const chatId = store?.chatOfSession(sessionId)
    const service = ctx.get('sessionTitle')
    const session = ctx.get('agents')?.get(sessionId)?.session
    if (chatId === undefined || session === undefined || typeof service?.refresh !== 'function' || titleRequests.has(sessionId)) return
    if (!showsPlaceholder(service, session, store.chat(chatId)?.placeholderTitle)) return
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    if (!events.some((event) => event?.type === 'user/message' && event.data?.source?.kind === 'user')) return
    titleRequests.add(sessionId)
    Promise.resolve()
      .then(() => service.refresh(session))
      .catch((error) => warn(`title of ${sessionId} not generated: ${messageOf(error)}`))
      .finally(() => titleRequests.delete(sessionId))
  }

  const prompts = createPrompts({
    chatOfAgent: (agent) => {
      const sessionId = agent.session?.id ?? agent.id
      const chatId = store?.chatOfSession(sessionId)
      if (chatId === undefined) return undefined
      // Only turns started from Delta Chat ask there; others ask where they started.
      return currentTurn(sessionId)?.ours === true ? chatId : undefined
    },
    send: (chatId, text) => notice(chatId, text),
    warn,
  })

  // ----------------------------------------------------------------- inbound

  /**
   * Handle one incoming message: check the sender, run a command or hand the
   * message to the chat's session, then mark it seen.
   * @param msgId - Delta Chat message id.
   */
  async function onIncoming(msgId) {
    if (handling.has(msgId)) return
    handling.add(msgId)
    try {
      await storeReady
      const { dc, accountId, fingerprints } = requireRuntime()
      let msg = await dc.rpc.getMessage(accountId, msgId)
      if (msg.isInfo || msg.fromId === SELF_CONTACT || msg.fromId <= 9) return
      if (msg.downloadState !== 'Done') {
        await dc.rpc.downloadFullMessage(accountId, msgId)
        for (let attempt = 0; attempt < 60 && msg.downloadState !== 'Done'; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          msg = await dc.rpc.getMessage(accountId, msgId)
        }
      }
      const chatId = msg.chatId
      const fingerprint = await fingerprints.get(msg.fromId)
      const allowed = allowedEntry(setting('allowedUsers', []), fingerprint)
      if (allowed === undefined) {
        await rejectSender(msg, fingerprint)
        return
      }
      const chatInfo = await dc.rpc.getBasicChatInfo(accountId, chatId)
      if (chatInfo.isContactRequest) await dc.rpc.acceptChat(accountId, chatId)
      const sender = { name: allowed.name, fingerprint, displayName: msg.sender?.displayName ?? '' }
      await noteChatIdentity(chatId, chatInfo, sender)
      await publishStatus({ lastMessageAt: Date.now(), lastChatId: chatId })
      const chat = chatState(chatId)
      chat.lastInbound = msgId
      const text = String(msg.text ?? '').trim()
      if (!msg.file && prompts.consumeReply(chatId, text)) {
        await dc.rpc.markseenMsgs(accountId, [msgId])
        return
      }
      const command = msg.file ? undefined : parseCommand(text)
      if (command !== undefined) {
        try {
          await runCommand(bridge, { chatId, chatInfo, sender, msgId }, command)
        } catch (error) {
          await notice(chatId, `❌ ${messageOf(error)}`)
        }
        await dc.rpc.markseenMsgs(accountId, [msgId])
        return
      }
      if (!text && !msg.file) return
      try {
        await dispatchPrompt(chatId, msg, sender)
      } catch (error) {
        // Left unseen, so the next start hands it over again.
        await notice(chatId, `❌ Your message did not reach the session: ${messageOf(error)}`)
        throw error
      }
      await dc.rpc.markseenMsgs(accountId, [msgId])
    } catch (error) {
      reportError(`message ${msgId}`, error)
    } finally {
      handling.delete(msgId)
    }
  }

  /** Ignore a sender who is not allowed, and remember them for the pending list. */
  async function rejectSender(msg, fingerprint) {
    const { dc, accountId } = requireRuntime()
    const entry = {
      fingerprint: fingerprint || `contact-${msg.fromId}`,
      displayName: msg.sender?.displayName ?? '',
      address: msg.sender?.address ?? '',
      chatId: msg.chatId,
    }
    const first = await store.notePending(entry)
    if (first) info(`ignored a message from ${entry.displayName || 'an unknown contact'} (${entry.fingerprint}); add the fingerprint to allowedUsers to let them in`)
    // Noticed, not seen: no read receipt goes back to a stranger.
    await dc.rpc.marknoticedChat(accountId, msg.chatId).catch(() => {})
  }

  /**
   * Hand a message to the chat's session: into the running turn (`steer`) or
   * after it (`queue`), with its sender line, quote and file.
   */
  async function dispatchPrompt(chatId, msg, sender) {
    const { dc, accountId } = requireRuntime()
    const chat = chatState(chatId)
    // Messages reach the session in the order they arrived.
    while (chat.admission !== undefined) await chat.admission
    let release
    chat.admission = new Promise((resolve) => { release = resolve })
    try {
      let quotedOwn = false
      let sentRecord
      if (msg.quote?.kind === 'WithMessage') {
        const quoted = await dc.rpc.getMessage(accountId, msg.quote.messageId).catch(() => undefined)
        quotedOwn = quoted?.fromId === SELF_CONTACT
        if (quotedOwn) sentRecord = store.sentRecord(msg.quote.messageId)
      }
      const prompt = await composePrompt(msg, {
        sender,
        chatId,
        quotedOwn,
        sentRecord,
        attachments: ctx.get('attachments'),
        voice: {
          mode: setting('transcriber', 'dsh'),
          language: setting('transcribeLanguage', ''),
          command: setting('transcribeCommand', []),
          ffmpeg: setting('ffmpegPath', 'ffmpeg'),
          speech: ctx.get('speech'),
        },
        signal: lifetime.signal,
        warn,
      })
      const agent = await ensureAgent(chatId)
      const sessionId = agent.session?.id ?? agent.id
      if (await unarchive(ctx, sessionId)) info(`unarchived session ${sessionId} for a message from chat ${chatId}`)
      const running = agent.status !== undefined && agent.status !== 'idle'
      const mode = running && setting('busyMessages', 'steer') !== 'queue' ? 'steer' : 'queue'
      const requestId = `${REQUEST_PREFIX}${chatId}:${msg.id}`
      await admitPrompt(ctx, agent, { requestId, text: prompt.text, attachments: prompt.attachments, mode }, lifetime.signal)
      if (running) {
        await dc.rpc.sendReaction(accountId, msg.id, [mode === 'steer' ? STEER_REACTION : '⏳']).catch(() => {})
      }
    } finally {
      chat.admission = undefined
      release()
    }
  }

  /** Record a reaction to one of the bot's messages in the chat's session. */
  async function onReaction(event) {
    await storeReady
    const { dc, accountId, fingerprints } = requireRuntime()
    const allowed = allowedEntry(setting('allowedUsers', []), await fingerprints.get(event.contactId))
    const sessionId = store.chat(event.chatId)?.sessionId
    if (allowed === undefined || typeof sessionId !== 'string') return
    const agent = ctx.get('agents')?.get(sessionId)
    if (agent === undefined) return
    const target = await dc.rpc.getMessage(accountId, event.msgId).catch(() => undefined)
    if (target === undefined) return
    const who = allowed.name || 'Someone'
    const what = event.reaction ? `reacted ${event.reaction}` : 'removed their reaction'
    const owner = target.fromId === SELF_CONTACT ? 'your message' : 'the message'
    const text = `[Delta Chat: ${who} ${what} to ${owner} ${target.id}:]\n${clip(target.text ?? target.fileName ?? '', 500)}`
    recordMessage(agent, {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: POST_SOURCE_KIND, form: 'notice', summary: clip(`${who} ${what}`, 120) },
    })
  }

  // ---------------------------------------------------------- send service

  const service = {
    send: (request = {}) => sendToChat(request),
    chats: () => listChats(),
    invite: () => invite(),
  }
  if (typeof ctx.provide === 'function') ctx.provide(SERVICE_NAME, service)

  // -------------------------------------------------------------- lifecycle

  async function startRuntime() {
    if (disposed || runtime !== undefined) return
    if (setting('enabled', true) === false) {
      await publishStatus({ state: 'disabled', detail: '' })
      return
    }
    await publishStatus({ state: 'starting', detail: '' })
    let server
    try {
      server = await startServer({ dir: accountsDir(), log: (line) => warn(line) })
      const { dc } = server
      // A server that quits during setup leaves its requests unanswered.
      const quit = server.exited.then((error) => { throw error })
      quit.catch(() => {})
      const setup = (task) => Promise.race([task, quit])
      dc.on('Error', (_account, event) => warn(`core error: ${event.msg ?? ''}`))
      dc.on('ErrorSelfNotInGroup', (_account, event) => warn(`core: ${event.msg ?? 'not in group'}`))
      const accountId = await setup(ensureAccount(dc, {
        relays: setting('relays', []),
        displayName: setting('displayName', 'DSH'),
        avatar: setting('avatar', ''),
        log: (line) => info(line),
      }))
      dc.on('IncomingMsg', (account, event) => {
        if (account === accountId) void onIncoming(event.msgId)
      })
      dc.on('IncomingReaction', (account, event) => {
        if (account === accountId) fireAndForget('reaction', () => onReaction(event))
      })
      dc.on('SecurejoinInviterProgress', (account, event) => {
        if (account === accountId && event.progress === 1000) fireAndForget('securejoin', () => noteJoined(event.contactId))
      })
      await setup(dc.rpc.startIo(accountId))
      if (disposed) {
        server.close()
        return
      }
      const current = { dc, accountId, close: server.close, startedAt: Date.now(), fingerprints: createFingerprints(dc, accountId), stopWatchdog: startWatchdog(dc, accountId, warn) }
      runtime = current
      void server.exited.then((error) => {
        if (runtime !== current) return
        reportError('core', error)
        stopRuntime()
        scheduleRetry()
      })
      retryDelay = RETRY_MIN_MS
      const { link } = await setup(invite())
      const primary = primaryAddress(link) ?? ''
      info(`running as ${primary}; invite link written to ${join(dataDir(), 'invite.txt')}`)
      await publishStatus({ state: 'running', detail: '', primary, invite: link })
      spool.start().catch((error) => reportError('spool', error))
      // Messages that arrived while the bot was down.
      for (const msgId of (await setup(dc.rpc.getFreshMsgs(accountId))).sort((left, right) => left - right)) void onIncoming(msgId)
    } catch (error) {
      reportError('start', error)
      await publishStatus({ state: 'error', detail: messageOf(error) })
      if (runtime === undefined) server?.close()
      stopRuntime()
      scheduleRetry()
    }
  }

  /** Log contacts that complete the bot's invite, with their fingerprint. */
  async function noteJoined(contactId) {
    const { dc, accountId, fingerprints } = requireRuntime()
    const fingerprint = await fingerprints.get(contactId)
    const contact = await dc.rpc.getContact(accountId, contactId).catch(() => undefined)
    const allowed = allowedEntry(setting('allowedUsers', []), fingerprint)
    if (allowed !== undefined) {
      info(`${allowed.name || fingerprint} joined through the invite`)
      return
    }
    await store.notePending({ fingerprint, displayName: contact?.displayName ?? '', address: contact?.address ?? '', chatId: null })
    info(`${contact?.displayName || 'a contact'} (${shortFingerprint(fingerprint)}) joined through the invite but is not in allowedUsers`)
  }

  function stopRuntime() {
    const current = runtime
    runtime = undefined
    spool.stop()
    if (current === undefined) return
    current.stopWatchdog?.()
    current.close()
    void publishStatus({ state: disposed ? 'stopped' : 'restarting' })
  }

  function scheduleRetry() {
    if (disposed || retryTimer !== undefined) return
    const delay = retryDelay
    retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2)
    info(`starting again in ${Math.round(delay / 1000)} s`)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void start()
    }, delay)
    retryTimer.unref?.()
  }

  function start() {
    starting ??= startRuntime().finally(() => { starting = undefined })
    return starting
  }

  async function restart(reason) {
    info(`restart: ${reason}`)
    await starting
    stopRuntime()
    await start()
  }

  /** Apply a settings change: start or stop, and bring the profile up to date. */
  async function applySettings() {
    if (setting('enabled', true) === false) {
      stopRuntime()
      await publishStatus({ state: 'disabled' })
      return
    }
    if (runtime === undefined) {
      await start()
      return
    }
    const { dc } = runtime
    await ensureAccount(dc, { relays: setting('relays', []), displayName: setting('displayName', 'DSH'), avatar: setting('avatar', ''), log: (line) => info(line) })
    await store.clearPending(setting('allowedUsers', []).map((entry) => normalizeFingerprint(entry.fingerprint)).filter(Boolean))
  }

  // Requests from the `dsh-deltachat` command.
  const spool = createSpool({
    ready: () => runtime !== undefined,
    onError: (error) => reportError('spool', error),
    handle: async (request) => {
      if (request.op === 'send') return sendToChat(request)
      if (request.op === 'invite') return invite()
      if (request.op === 'join') return joinInvite(String(request.link ?? ''))
      if (request.op === 'status') return describe()
      if (request.op === 'chats') return listChats()
      if (request.op === 'allow') return allowUser(request.fingerprint, request.name)
      throw new Error(`unknown request ${request.op}`)
    },
  })

  /** What commands may use. */
  const bridge = {
    ctx,
    setting,
    store: () => store,
    runtime: requireRuntime,
    chatState,
    currentTurn,
    ensureAgent,
    notice,
    sendText,
    modelCatalog,
    prompts,
    describe,
    invite,
    restart: (reason) => fireAndForget('restart', () => restart(reason)),
    applyTitle,
    info,
    warn,
    signal: lifetime.signal,
  }

  ctx.on('session/event', (session, event) => {
    try {
      turns.onSessionEvent(session, event)
    } catch (error) {
      reportError('session-event', error)
    }
    // Titles change after the title service folded this event.
    if (store === undefined || store.chatOfSession(session?.id) === undefined) return
    if (event?.type === 'session/title' && event.data?.source?.kind !== 'user') fireAndForget('title', () => applyTitle(session.id))
    else if (event?.type === 'request/header') fireAndForget('title', () => startTitle(session.id))
  }, { global: true })

  ctx.on('settings/document-updated', (namespace) => {
    if (namespace === name) fireAndForget('settings', () => applySettings())
  })

  ctx.effect(() => {
    void storeReady.then(() => start()).catch((error) => reportError('start', error))
    return () => {
      disposed = true
      lifetime.abort()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      prompts.cancelAll()
      stopRuntime()
    }
  }, 'dsh-deltachat-bot: runtime')
}
