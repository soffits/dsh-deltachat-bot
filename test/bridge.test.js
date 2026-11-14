import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBridge } from '../src/app.js'
import { makeDeltaChat, makeHost, settle, until } from './fake.js'

/** Start a bridge on fakes and wait until it runs. */
async function start(options = {}) {
  const host = makeHost(options)
  const chat = makeDeltaChat()
  createBridge(host.ctx, host.config, chat.core)
  for (let attempt = 0; attempt < 50 && !chat.calls.some((call) => call.name === 'getFreshMsgs'); attempt += 1) await settle(10)
  return { host, chat }
}

/** Run one turn of a session through the bridge's event listener. */
function runTurn(host, sessionId, turn, { requestId, answer, reason = { kind: 'completed' }, source }) {
  host.sessionEvent(sessionId, 'turn/start', { turn })
  if (requestId !== undefined) host.sessionEvent(sessionId, 'user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user', rpcId: requestId } })
  if (source !== undefined) host.sessionEvent(sessionId, 'user/message', { id: 'w', role: 'user', content: [{ type: 'text', text: 'from the web' }], source })
  host.sessionEvent(sessionId, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: 'Checking.' }, { type: 'tool-call' }] } })
  if (answer !== undefined) host.sessionEvent(sessionId, 'assistant/message', { turn, step: 2, message: { content: [{ type: 'text', text: answer }] } })
  host.sessionEvent(sessionId, 'turn/end', { turn, reason })
}

const texts = (chat) => chat.sent.map((message) => message.text)

test('an allowed message becomes a prompt in a new session, and the answer comes back as plain text', async () => {
  const { host, chat } = await start()
  const msgId = await chat.handled(chat.addIncoming({ text: 'hello' }))
  assert.equal(host.prompts.length, 1)
  const [prompt] = host.prompts
  assert.equal(prompt.requestId, `deltachat:10:${msgId}`)
  assert.equal(prompt.mode, 'queue')
  assert.match(prompt.content[0].text, /^\[Delta Chat message from Tester \(Delta Chat name "Test Person", key 425AAD93\w+, chat 10, message \d+\)\]\nhello$/u)
  assert.ok(chat.calls.some((call) => call.name === 'markseenMsgs' && call.args[1][0] === msgId))
  runTurn(host, prompt.sessionId, 1, { requestId: prompt.requestId, answer: 'Hi **there**.' })
  await until(() => chat.sent.length > 0, 'the answer')
  assert.deepEqual(texts(chat), ['Hi there.'])
  assert.equal(chat.sent[0].quotedMessageId, null)
  host.dispose()
})

test('a stranger is ignored and remembered, with no read receipt', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'let me in', fromId: 12 }))
  assert.equal(host.prompts.length, 0)
  assert.deepEqual(chat.sent, [])
  assert.ok(chat.calls.some((call) => call.name === 'marknoticedChat'))
  assert.ok(!chat.calls.some((call) => call.name === 'markseenMsgs'))
  const status = await (await import('node:fs/promises')).readFile(`${process.env.DSH_HOME}/deltachat/state.json`, 'utf8')
  assert.match(status, /contact-12/u)
  host.dispose()
})

test('a message during a running turn is steered into it and marked with a reaction', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'first' }))
  const sessionId = host.prompts[0].sessionId
  host.agents.get(sessionId).status = 'running'
  const second = await chat.handled(chat.addIncoming({ text: 'also this' }))
  assert.equal(host.prompts[1].mode, 'steer')
  assert.ok(chat.calls.some((call) => call.name === 'sendReaction' && call.args[1] === second && call.args[2][0] === '👀'))
  host.dispose()
})

test('the answer quotes its prompt when newer messages arrived meanwhile', async () => {
  const { host, chat } = await start()
  const first = await chat.handled(chat.addIncoming({ text: 'first' }))
  const { sessionId, requestId } = host.prompts[0]
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  await chat.handled(chat.addIncoming({ text: '/ping' }))
  host.sessionEvent(sessionId, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Answer.' }] } })
  host.sessionEvent(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => texts(chat).includes('Answer.'), 'the answer')
  const answer = chat.sent.find((message) => message.text === 'Answer.')
  assert.equal(answer.quotedMessageId, first)
  host.dispose()
})

test('turns started elsewhere are mirrored, failures reported, and [SILENT] posts nothing', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const { sessionId, requestId } = host.prompts[0]
  runTurn(host, sessionId, 1, { source: { kind: 'user', rpcId: 'web-1' }, answer: 'Web answer' })
  runTurn(host, sessionId, 2, { requestId, reason: { kind: 'error', error: { message: 'rate limited' } } })
  runTurn(host, sessionId, 3, { requestId, answer: '[SILENT]' })
  runTurn(host, sessionId, 4, { requestId, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await until(() => chat.sent.length >= 3, 'three messages')
  await settle()
  assert.deepEqual(texts(chat), ['🖥 From Web:\nfrom the web', 'Web answer', '❌ rate limited'])
  host.dispose()
})

test('with mirroring off only Delta Chat turns are delivered', async () => {
  const { host, chat } = await start({ config: { mirrorTurns: false } })
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const { sessionId, requestId } = host.prompts[0]
  runTurn(host, sessionId, 1, { source: { kind: 'user', rpcId: 'web-1' }, answer: 'Web answer' })
  runTurn(host, sessionId, 2, { requestId, answer: 'Mine' })
  await until(() => texts(chat).includes('Mine'), 'the answer')
  await settle()
  assert.deepEqual(texts(chat), ['Mine'])
  host.dispose()
})

test('commands pick models by number, start new sessions and stop turns', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const sessionId = host.prompts[0].sessionId
  await chat.handled(chat.addIncoming({ text: '/model' }))
  assert.match(texts(chat).at(-1), /1\. Provider One \(1\) ✅\n2\. Provider Two \(2\)/u)
  await chat.handled(chat.addIncoming({ text: '/model 2' }))
  assert.match(texts(chat).at(-1), /2\. Model Three/u)
  await chat.handled(chat.addIncoming({ text: '/model 2 2' }))
  assert.equal(texts(chat).at(-1), '🤖 Model: Model Three')
  assert.deepEqual(host.selected.at(-1), { sessionId, provider: 'p2', model: 'm3' })
  host.agents.get(sessionId).status = 'running'
  await chat.handled(chat.addIncoming({ text: '/new' }))
  assert.match(texts(chat).at(-1), /Stop the running turn first/u)
  await chat.handled(chat.addIncoming({ text: '/stop' }))
  assert.equal(host.agents.get(sessionId).cancelled, 1)
  assert.equal(texts(chat).at(-1), '⏹ Stopped.')
  host.agents.get(sessionId).status = 'idle'
  await chat.handled(chat.addIncoming({ text: '/new' }))
  assert.match(texts(chat).at(-1), /^🆕 New session/u)
  await chat.handled(chat.addIncoming({ text: 'next' }))
  const next = host.prompts.at(-1)
  assert.notEqual(next.sessionId, sessionId)
  assert.deepEqual(host.agents.get(next.sessionId).model.selection, { provider: 'p2', model: 'm3' })
  await chat.handled(chat.addIncoming({ text: '/help' }))
  assert.match(texts(chat).at(-1), /^Commands:\n\/help/u)
  host.dispose()
})

test('/fork opens a group with the allowed members, bound to the forked session', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const sessionId = host.prompts[0].sessionId
  await chat.handled(chat.addIncoming({ text: '/fork Side quest' }))
  const group = [...chat.chats.values()].find((entry) => entry.name === 'Side quest')
  assert.deepEqual(group.contacts, [11])
  assert.match(texts(chat).at(-1), /Forked into the new group "Side quest"/u)
  await chat.handled(chat.addIncoming({ text: 'in the fork', chatId: group.id }))
  assert.equal(host.prompts.at(-1).sessionId, `${sessionId}-fork`)
  host.dispose()
})

test('the send service delivers, records the send, and a quote of it names the job', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const sessionId = host.prompts[0].sessionId
  const result = await host.service().send({ to: 10, text: 'Plan for **today**', from: { job: 'Daily plan' } })
  assert.equal(result.recorded, true)
  assert.equal(texts(chat).at(-1), 'Plan for today')
  const events = host.agents.get(sessionId).session.snapshotEvents()
  assert.match(events.at(-1).data.content[0].text, /^\[Sent to Delta Chat chat "Test Person" by job "Daily plan"\]\nPlan for \*\*today\*\*/u)
  await chat.handled(chat.addIncoming({ text: 'ok', quote: { kind: 'WithMessage', messageId: result.messageIds[0], text: 'Plan for today' } }))
  assert.match(host.prompts.at(-1).content[0].text, /\[Replying to a message job "Daily plan" sent here:\]\nPlan for \*\*today\*\*/u)
  await assert.rejects(host.service().send({ to: 99, text: 'x' }), /Unknown chat 99/u)
  await assert.rejects(host.service().send({ to: 10, files: ['relative.txt'] }), /must be absolute/u)
  host.dispose()
})

test('a question from a Delta Chat turn is asked in the chat and answered by number', async () => {
  const { host, chat } = await start()
  await chat.handled(chat.addIncoming({ text: 'hello' }))
  const { sessionId, requestId } = host.prompts[0]
  const agent = host.agents.get(sessionId)
  host.sessionEvent(sessionId, 'turn/start', { turn: 1 })
  host.sessionEvent(sessionId, 'user/message', { source: { kind: 'user', rpcId: requestId } })
  const [handler] = agent.handlers.get('user-questions/request')
  const answer = handler({ questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }, () => 'unhandled')
  await settle()
  assert.match(texts(chat).at(-1), /❓ Which\?\n\n1\. A\n2\. B/u)
  chat.addIncoming({ text: '2' })
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['B'] }] })
  assert.equal(host.prompts.length, 1)
  const [approval] = agent.handlers.get('approval/request')
  const outcome = approval({ toolName: 'bash', reason: 'rm -rf build' }, () => 'unhandled')
  await settle()
  assert.match(texts(chat).at(-1), /Approval needed for bash/u)
  chat.addIncoming({ text: '/allow' })
  assert.equal(await outcome, 'allowed-once')
  host.dispose()
})

test('the command line can allow a key and join only allowed invites', async () => {
  const { host, chat } = await start()
  const edits = []
  host.ctx.fiber = { entry: 'entry-1' }
  host.services.configEditor = {
    async edit(entry, change) {
      const next = change({ allowedUsers: host.config.allowedUsers.get() })
      edits.push({ entry, next })
      host.config.allowedUsers.value = next.allowedUsers
    },
  }
  const { enqueue, waitForResult } = await import('../src/spool.js')
  const allowed = await waitForResult(await enqueue({ op: 'allow', fingerprint: '3c1f 9e0a 5b7d 2468 ace0 1357 9bdf 0246 8ace 1357', name: 'Friend' }), 5000)
  assert.deepEqual(allowed, { ok: true, result: { fingerprint: '3C1F9E0A5B7D2468ACE013579BDF02468ACE1357', name: 'Friend' } })
  assert.equal(edits[0].entry, 'entry-1')
  assert.equal(host.config.allowedUsers.get().length, 2)
  chat.handlers.checkQr = async (_account, link) => ({ kind: 'askVerifyContact', fingerprint: link.endsWith('friend') ? '3C1F 9E0A 5B7D 2468 ACE0 1357 9BDF 0246 8ACE 1357' : 'AAAA BBBB CCCC DDDD EEEE FFFF 0000 1111 2222 3333' })
  chat.handlers.secureJoin = async () => 42
  const refused = await waitForResult(await enqueue({ op: 'join', link: 'https://i.delta.chat/#stranger' }), 5000)
  assert.equal(refused.ok, false)
  assert.match(refused.error, /not in allowedUsers/u)
  const joined = await waitForResult(await enqueue({ op: 'join', link: 'https://i.delta.chat/#friend' }), 5000)
  assert.deepEqual(joined.result, { chatId: 42, name: 'Friend', fingerprint: '3C1F9E0A5B7D2468ACE013579BDF02468ACE1357' })
  host.dispose()
})

test('chat sessions are titled DeltaChat-<person>-<task>, from the people file when set', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const file = join(await mkdtemp(join(tmpdir(), 'people-')), 'people.json')
  const { TESTER_FINGERPRINT } = await import('./fake.js')
  await writeFile(file, JSON.stringify({ deltachat_keys: { [TESTER_FINGERPRINT]: 'Sam' } }))
  const { host, chat } = await start({ config: { peopleFile: file } })
  await chat.handled(chat.addIncoming({ text: 'book the train please' }))
  const sessionId = host.prompts[0].sessionId
  const session = host.agents.get(sessionId).session
  const title = () => host.services.sessionTitle.get(session)?.title
  assert.equal(title(), 'DeltaChat-Sam-Test Person')
  session.append('user/message', { source: { kind: 'user', rpcId: host.prompts[0].requestId }, content: [{ type: 'text', text: host.prompts[0].content[0].text }] })
  host.sessionEvent(sessionId, 'request/header', {})
  await until(() => title() !== 'DeltaChat-Sam-Test Person', 'the generated title')
  host.sessionEvent(sessionId, 'session/title', { source: { kind: 'fallback' } })
  await until(() => title() === 'DeltaChat-Sam-book the train please', 'the prefixed title')
  await chat.handled(chat.addIncoming({ text: '/rename Train trip' }))
  assert.equal(title(), 'DeltaChat-Sam-Train trip')
  host.dispose()
})
