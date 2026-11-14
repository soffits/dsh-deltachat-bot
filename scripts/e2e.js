#!/usr/bin/env node
/**
 * End-to-end check against real chatmail relays: the bot (real Delta Chat
 * core, fake DSH Host) and two throwaway accounts driven by the same core
 * library, one allowed and one not. Every account is new and lives in a
 * temporary directory that is removed at the end.
 *
 *   npm run e2e                     # default relays
 *   E2E_BOT_RELAYS=a.example,b.example E2E_TESTER_RELAY=c.example npm run e2e
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const root = await mkdtemp(join(tmpdir(), 'dsh-deltachat-e2e-'))
process.env.DSH_HOME = join(root, 'home')
const botRelays = (process.env.E2E_BOT_RELAYS ?? 'nine.testrun.org,chtml.ca').split(',').map((relay) => relay.trim()).filter(Boolean)
const testerRelay = process.env.E2E_TESTER_RELAY ?? 'nine.testrun.org'

const { createBridge } = await import('../src/app.js')
const core = await import('../src/core.js')
const { makeHost } = await import('../test/fake.js')
const { messageData, startServer } = core

const log = (line) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`)
const wait = async (check, what, seconds = 120) => {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

let testers
let host
let failed = false
try {
  // Two people: one allowed, one stranger.
  testers = await startServer({ dir: join(root, 'testers'), log })
  const { dc } = testers
  const people = {}
  for (const name of ['Allowed Person', 'Stranger']) {
    const id = await dc.rpc.addAccount()
    await dc.rpc.batchSetConfig(id, { displayname: name })
    await dc.rpc.addTransportFromQr(id, `dcaccount:${testerRelay}`)
    await dc.rpc.startIo(id)
    const invite = await dc.rpc.getChatSecurejoinQrCode(id, null)
    people[name] = { id, fingerprint: decodeURIComponent(invite.split('#')[1].split('&')[0]), incoming: [] }
  }
  const joined = new Set()
  dc.on('SecurejoinJoinerProgress', (account, event) => {
    if (event.progress === 1000) joined.add(account)
  })
  dc.on('IncomingMsg', (account, event) => {
    for (const person of Object.values(people)) if (person.id === account) person.incoming.push(event.msgId)
  })
  const allowed = people['Allowed Person']
  const stranger = people.Stranger
  log(`testers ready on ${testerRelay}`)

  const picture = join(root, 'dot.png')
  await writeFile(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
  host = makeHost({ config: { relays: botRelays, transcriber: 'off', displayName: 'E2E Bot', avatar: picture, allowedUsers: [{ fingerprint: allowed.fingerprint, name: 'Allowed' }] } })
  createBridge(host.ctx, host.config, core)
  const status = async () => JSON.parse(await readFile(join(process.env.DSH_HOME, 'deltachat', 'status.json'), 'utf8').catch(() => '{}'))
  await wait(async () => (await status()).state === 'running', 'the bot to run', 180)
  const botInvite = (await readFile(join(process.env.DSH_HOME, 'deltachat', 'invite.txt'), 'utf8')).trim()
  const relaysInInvite = [...botInvite.matchAll(/(?:a|r)=([^&]+)/gu)].flatMap((match) => decodeURIComponent(match[1]).split(','))
  log(`bot running; invite lists ${relaysInInvite.join(', ')}`)
  assert.equal(relaysInInvite.length, botRelays.length, 'the invite carries every relay')

  // The allowed person joins the bot's invite and writes.
  const chatWithBot = await dc.rpc.secureJoin(allowed.id, botInvite)
  const strangerChat = await dc.rpc.secureJoin(stranger.id, botInvite)
  await wait(() => joined.has(allowed.id) && joined.has(stranger.id), 'the joins', 180)
  const textOf = async (person, msgId) => (await dc.rpc.getMessage(person.id, msgId)).text
  const sendAs = (person, chatId, data) => dc.rpc.sendMsg(person.id, chatId, messageData(data))

  await sendAs(allowed, chatWithBot, { text: 'hello bot' })
  const first = await wait(() => host.prompts[0], 'the first prompt')
  assert.match(first.content[0].text, /^\[Delta Chat message from Allowed \(Delta Chat name "Allowed Person", key [0-9A-F]{40}, chat \d+, message \d+\)\]\nhello bot$/u)
  log('text reached the session with the sender line')

  // The stranger is ignored.
  await sendAs(stranger, strangerChat, { text: 'let me in' })
  await wait(async () => JSON.parse(await readFile(join(process.env.DSH_HOME, 'deltachat', 'state.json'), 'utf8')).pending?.[stranger.fingerprint], 'the stranger to be noted')
  assert.equal(host.prompts.length, 1)
  log('stranger ignored and listed as pending')

  // A turn's answer goes back as plain text.
  const sessionId = first.sessionId
  const turn = (number, requestId, answer) => {
    host.sessionEvent(sessionId, 'turn/start', { turn: number })
    host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
    host.sessionEvent(sessionId, 'assistant/message', { turn: number, message: { content: [{ type: 'text', text: answer }] } })
    host.sessionEvent(sessionId, 'turn/end', { turn: number, reason: { kind: 'completed' } })
  }
  turn(1, first.requestId, 'Hi **there**, see [the docs](https://example.org).')
  const answerId = await wait(async () => {
    for (const msgId of allowed.incoming) if (await textOf(allowed, msgId) === 'Hi there, see the docs (https://example.org).') return msgId
    return undefined
  }, 'the answer')
  log('answer arrived as plain text')

  // The bot's name and avatar reach the other side.
  const botContact = (await dc.rpc.getChatContacts(allowed.id, chatWithBot)).find((id) => id > 9)
  await wait(async () => {
    const contact = await dc.rpc.getContact(allowed.id, botContact)
    return contact.displayName === 'E2E Bot' && contact.profileImage
  }, 'the bot name and avatar')
  log('bot name and avatar arrived')

  // A picture, a quote and a command.
  await sendAs(allowed, chatWithBot, { text: 'a picture', file: picture, viewtype: 'Image' })
  const withPicture = await wait(() => host.prompts.find((prompt) => /a picture$/u.test(prompt.content?.[0]?.text ?? '')) ?? host.agents.get(sessionId)?.received.find((message) => /a picture$/u.test(message.content[0].text)), 'the picture prompt')
  assert.ok((withPicture.content ?? []).some((block) => block.type === 'image'), 'the picture is attached as an image')
  log('picture reached the session as an image')

  await sendAs(allowed, chatWithBot, { text: 'about that', quotedMessageId: answerId })
  const quoted = await wait(() => host.prompts.find((prompt) => /about that$/u.test(prompt.content[0].text)), 'the quoted prompt')
  assert.match(quoted.content[0].text, /\[Replying to your earlier message:\]\nHi there, see the docs/u)
  log('quote carried into the prompt')

  const before = allowed.incoming.length
  await sendAs(allowed, chatWithBot, { text: '/ping' })
  await wait(async () => {
    for (const msgId of allowed.incoming.slice(before)) if (await textOf(allowed, msgId) === 'pong') return true
    return false
  }, 'pong')
  log('/ping answered')

  // A reaction to the bot's message is recorded in the session.
  await dc.rpc.sendReaction(allowed.id, answerId, ['👍'])
  await wait(() => host.agents.get(sessionId).session.snapshotEvents().some((event) => /reacted 👍/u.test(event.data?.content?.[0]?.text ?? '')), 'the reaction note')
  log('reaction recorded in the session')

  // Other plugins and the command line send through the service and the spool.
  const botChat = await wait(() => host.prompts[0] && Number(host.prompts[0].requestId.split(':')[1]), 'the chat id')
  const sent = await host.service().send({ to: botChat, text: 'From a job', files: [picture], from: { job: 'E2E job' } })
  assert.equal(sent.recorded, true)
  await wait(async () => {
    for (const msgId of allowed.incoming) {
      const msg = await dc.rpc.getMessage(allowed.id, msgId)
      if (msg.viewType === 'Image' && msg.file) return true
    }
    return false
  }, 'the sent picture', 60).catch(async (error) => {
    for (const msgId of allowed.incoming) {
      const msg = await dc.rpc.getMessage(allowed.id, msgId)
      log(`  got ${msg.viewType} ${JSON.stringify(msg.text).slice(0, 40)} file=${msg.fileName} state=${msg.downloadState}`)
    }
    throw error
  })
  const cli = await promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'bin', 'dsh-deltachat.js'), 'status'], { env: { ...process.env } })
  const described = JSON.parse(cli.stdout)
  assert.equal(described.running, true)
  assert.equal(described.relays.length, botRelays.length)
  log(`service and command line work; bot relays ${described.relays.join(', ')}`)

  // A group made by the allowed person gets its own session.
  const group = await dc.rpc.createGroupChat(allowed.id, 'E2E group', false)
  await dc.rpc.addContactToChat(allowed.id, group, botContact)
  await sendAs(allowed, group, { text: 'hello group' })
  const groupPrompt = await wait(() => host.prompts.find((prompt) => /hello group$/u.test(prompt.content[0].text)), 'the group prompt')
  assert.notEqual(groupPrompt.sessionId, sessionId)
  log('group chat opened its own session')
  log('E2E PASSED')
} catch (error) {
  failed = true
  log(`E2E FAILED: ${error?.stack ?? JSON.stringify(error)}`)
} finally {
  host?.dispose()
  testers?.close()
  await new Promise((resolve) => setTimeout(resolve, 500))
  await rm(root, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
