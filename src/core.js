/**
 * The Delta Chat side: one chatmail profile driven through the official
 * `deltachat-rpc-server` (JSON-RPC over stdio).
 *
 * The server is spawned here rather than with `startDeltaChat` from
 * `@deltachat/stdio-rpc-server`, because that helper throws from the child's
 * `exit` and `error` handlers, which would take the whole Host process down
 * when the server quits. Here an unexpected exit resolves `exited`.
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { getRPCServerPath } from '@deltachat/stdio-rpc-server'
import { StdioDeltaChat } from '@deltachat/jsonrpc-client'
import { vcardFingerprint } from './identity.js'

/** Connectivity at or above this value means connected (DC_CONNECTIVITY_CONNECTED is 4000). */
const CONNECTED = 4000
/** Connectivity at or above this value is at least trying (connecting, working). */
const CONNECTING = 3000

/**
 * A complete `MessageData` object; the RPC server wants every field.
 * @param data - fields to set.
 * @returns the message data.
 */
export function messageData(data) {
  return {
    text: null,
    html: null,
    viewtype: null,
    file: null,
    filename: null,
    location: null,
    overrideSenderName: null,
    quotedMessageId: null,
    quotedText: null,
    ...data,
  }
}

/** File extensions and the Delta Chat view type they are sent as. */
const VIEW_TYPES = new Map([
  ['.jpg', 'Image'], ['.jpeg', 'Image'], ['.png', 'Image'], ['.webp', 'Image'], ['.heic', 'Image'],
  ['.gif', 'Gif'],
  ['.mp4', 'Video'], ['.mov', 'Video'], ['.webm', 'Video'], ['.mkv', 'Video'],
  ['.mp3', 'Audio'], ['.m4a', 'Audio'], ['.ogg', 'Audio'], ['.opus', 'Audio'], ['.wav', 'Audio'], ['.flac', 'Audio'],
])

/**
 * How a file is shown in Delta Chat, by its extension.
 * @param path - file path.
 * @returns a Delta Chat view type.
 */
export function viewTypeOf(path) {
  return VIEW_TYPES.get(extname(String(path)).toLowerCase()) ?? 'File'
}

/**
 * Start the RPC server on an accounts directory.
 * @param options - `{ dir, log }`.
 * @returns `{ dc, close, exited }`; `dc` is a `StdioDeltaChat` with its event
 *   loop running; `exited` resolves with an error when the server quits
 *   without `close` (requests in flight then never settle, so callers race
 *   their work against it).
 */
export async function startServer({ dir, log }) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const binary = getRPCServerPath()
  const child = spawn(binary, [], {
    env: {
      ...(process.env.RUST_LOG === undefined ? {} : { RUST_LOG: process.env.RUST_LOG }),
      DC_ACCOUNTS_PATH: dir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let closing = false
  let stderr = ''
  let reportExit
  const exited = new Promise((resolve) => { reportExit = resolve })
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-2000)
  })
  child.on('error', (error) => {
    if (!closing) reportExit(new Error(`deltachat-rpc-server could not run: ${error.message}`))
  })
  child.on('exit', (code, signal) => {
    if (closing) return
    const tail = stderr.trim().split('\n').slice(-3).join(' | ')
    reportExit(new Error(`deltachat-rpc-server quit (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ''}`))
  })
  // Writes after the server died must not become uncaught errors.
  child.stdin.on('error', (error) => log?.(`rpc stdin: ${error.message}`))
  const dc = new StdioDeltaChat(child.stdin, child.stdout, true)
  dc.eventTask?.catch?.((error) => {
    if (!closing) log?.(`event loop stopped: ${error?.message ?? error}`)
  })
  return {
    dc,
    exited,
    close() {
      closing = true
      child.kill()
    },
  }
}

/**
 * Create the bot profile on the first start, or bring an existing one up to
 * the configured relays and look.
 * @param dc - client.
 * @param options - `{ relays, displayName, avatar, log }`.
 * @returns the account id.
 */
export async function ensureAccount(dc, { relays, displayName, avatar, log }) {
  const ids = await dc.rpc.getAllAccountIds()
  const accountId = ids[0] ?? await dc.rpc.addAccount()
  await dc.rpc.batchSetConfig(accountId, { bot: '1', displayname: displayName || 'DSH' })
  if (typeof avatar === 'string' && avatar.length > 0) {
    try {
      await dc.rpc.setConfig(accountId, 'selfavatar', avatar)
    } catch (error) {
      log?.(`avatar ${avatar} not set: ${error?.message ?? error}`)
    }
  }
  const wanted = relays.map((relay) => String(relay).trim().toLowerCase()).filter((relay) => relay.length > 0)
  const present = new Set((await dc.rpc.listTransports(accountId).catch(() => []))
    .map((transport) => String(transport.addr).split('@')[1]?.toLowerCase())
    .filter(Boolean))
  const failures = []
  for (const relay of wanted) {
    if (present.has(relay)) continue
    try {
      await dc.rpc.addTransportFromQr(accountId, `dcaccount:${relay}`)
      present.add(relay)
      log?.(`added relay ${relay}`)
    } catch (error) {
      failures.push(`${relay}: ${error?.message ?? error}`)
    }
  }
  if (!await dc.rpc.isConfigured(accountId)) {
    throw new Error(`no relay could create the Delta Chat profile (${failures.join('; ') || 'no relays configured'})`)
  }
  for (const failure of failures) log?.(`relay not added: ${failure}`)
  return accountId
}

/**
 * Write the bot's invite link and its QR code next to the profile.
 * @param dc - client.
 * @param accountId - account.
 * @param dir - directory for `invite.txt` and `invite.svg`.
 * @returns `{ link, svgPath }`.
 */
export async function writeInvite(dc, accountId, dir) {
  const link = await dc.rpc.getChatSecurejoinQrCode(accountId, null)
  const svg = await dc.rpc.createQrSvg(link)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const svgPath = join(dir, 'invite.svg')
  await writeFile(join(dir, 'invite.txt'), `${link}\n`, { mode: 0o600 })
  await writeFile(svgPath, svg, { mode: 0o600 })
  return { link, svgPath }
}

/**
 * Fingerprints of contacts, cached by contact id. A contact's key never
 * changes in Delta Chat (a new key is a new contact), so entries stay valid.
 * @param dc - client.
 * @param accountId - account.
 * @returns `get(contactId)` resolving to the fingerprint or ''.
 */
export function createFingerprints(dc, accountId) {
  const cache = new Map()
  return {
    async get(contactId) {
      if (cache.has(contactId)) return cache.get(contactId)
      let fingerprint = ''
      try {
        fingerprint = vcardFingerprint(await dc.rpc.makeVcard(accountId, [contactId]))
      } catch {
        fingerprint = ''
      }
      if (fingerprint !== '') cache.set(contactId, fingerprint)
      return fingerprint
    },
  }
}

/**
 * Keep IO healthy: restart it when connectivity stays down or the inbox has
 * been quiet for too long, and nudge the network now and then. Delta Chat
 * recovers by itself in most cases; this covers long sleeps and dead sockets.
 * @param dc - client.
 * @param accountId - account.
 * @param log - logger for restarts.
 * @returns a stop function.
 */
export function startWatchdog(dc, accountId, log) {
  let bad = 0
  let lastIdle = Date.now()
  const onIdle = (contextId) => {
    if (contextId === accountId) lastIdle = Date.now()
  }
  dc.on('ImapInboxIdle', onIdle)
  const restart = async (reason) => {
    log(`restarting IO: ${reason}`)
    try {
      await dc.rpc.stopIo(accountId)
      await dc.rpc.startIo(accountId)
      lastIdle = Date.now()
      bad = 0
    } catch (error) {
      log(`IO restart failed: ${error?.message ?? error}`)
    }
  }
  const check = setInterval(async () => {
    try {
      const connectivity = await dc.rpc.getConnectivity(accountId)
      bad = connectivity < CONNECTING ? bad + 1 : 0
      if (bad >= 2) await restart(`connectivity ${connectivity} on two checks`)
      else if (Date.now() - lastIdle > 20 * 60_000 && connectivity < CONNECTED) await restart('no inbox idle for 20 minutes')
    } catch (error) {
      log(`watchdog: ${error?.message ?? error}`)
    }
  }, 5 * 60_000)
  const nudge = setInterval(() => {
    dc.rpc.maybeNetwork().catch(() => {})
  }, 10 * 60_000)
  check.unref?.()
  nudge.unref?.()
  return () => {
    clearInterval(check)
    clearInterval(nudge)
    dc.off?.('ImapInboxIdle', onIdle)
  }
}
