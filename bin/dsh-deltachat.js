#!/usr/bin/env node
/**
 * Talk to the running DSH Delta Chat bot from a shell: send messages, show
 * its invite link, join someone's invite, list chats, allow a contact.
 *
 * Requests go through the plugin's file spool under $DSH_HOME/deltachat, so
 * no network access to DSH is needed, and a send waits there while DSH is
 * not running.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { dataDir } from '../src/constants.js'
import { enqueue, waitForResult, withdraw } from '../src/spool.js'

const usage = `Usage: dsh-deltachat <command> [options]

Commands:
  send --chat <id> [--file <path>]... [--reply-to <msg>] [--job <name>] [text...]
        Send text (from the arguments, or stdin when none are given) and files
        into a chat. The message is also recorded in the chat's session.
  react --chat <id> --reply-to <msg> <emoji>
        React to a message (an empty emoji removes the reaction).
  invite
        Print the bot's invite link; its QR code is in ${join('$DSH_HOME', 'deltachat', 'invite.svg')}.
  join <invite-link>
        Join someone's invite link (their key must be in allowedUsers).
  allow <fingerprint> [--name <label>]
        Add a key to allowedUsers (writes the profile's configuration).
  chats
        List the chats bound to sessions.
  status
        Show the bot's state, relays and the contacts it ignored.

Options:
  --timeout <seconds>   how long to wait for the bot (default 30)
  --no-wait             queue a send and return at once

Exit codes: 0 done, 1 failed, 2 bad arguments, 3 the bot did not answer in time.`

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

let parsed
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      chat: { type: 'string', short: 'c' },
      file: { type: 'string', short: 'f', multiple: true },
      'reply-to': { type: 'string' },
      job: { type: 'string', short: 'j' },
      'from-session': { type: 'string' },
      name: { type: 'string' },
      timeout: { type: 'string' },
      'no-wait': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
} catch (error) {
  fail(`${error.message}\n\n${usage}`)
}
const { values, positionals } = parsed
const [command, ...rest] = positionals
if (values.help || command === undefined) {
  process.stdout.write(`${usage}\n`)
  process.exit(values.help ? 0 : 2)
}
const timeoutMs = Math.max(1, Number(values.timeout ?? 30)) * 1000

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

let request
if (command === 'send' || command === 'react') {
  if (values.chat === undefined || !/^\d+$/u.test(values.chat.trim())) fail('--chat takes the numeric chat id (/id in the chat shows it).')
  const sessionId = values['from-session'] ?? process.env.DSH_SESSION_ID
  const from = {
    ...(values.job ? { job: values.job } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(!values.job && !sessionId ? { label: 'dsh-deltachat' } : {}),
  }
  if (command === 'react') {
    if (values['reply-to'] === undefined) fail('react needs --reply-to <message id>.')
    request = { op: 'send', to: values.chat.trim(), replyTo: values['reply-to'], reaction: rest.join(' '), from }
  } else {
    const text = rest.length > 0 ? rest.join(' ') : (values.file?.length ? '' : readStdin())
    request = {
      op: 'send',
      to: values.chat.trim(),
      text,
      files: (values.file ?? []).map((path) => resolve(path)),
      ...(values['reply-to'] === undefined ? {} : { replyTo: values['reply-to'] }),
      from,
    }
  }
} else if (command === 'invite' || command === 'chats' || command === 'status') {
  request = { op: command }
} else if (command === 'join') {
  if (rest.length !== 1) fail('join takes one invite link.')
  request = { op: 'join', link: rest[0] }
} else if (command === 'allow') {
  if (rest.length !== 1) fail('allow takes one fingerprint (quote it if it has spaces).')
  request = { op: 'allow', fingerprint: rest[0], name: values.name ?? '' }
} else {
  fail(`Unknown command ${command}.\n\n${usage}`)
}

const id = await enqueue(request)
if (values['no-wait'] && request.op === 'send') {
  process.stdout.write(`queued ${id}\n`)
  process.exit(0)
}
const result = await waitForResult(id, timeoutMs)
if (result === undefined) {
  // Only sends keep waiting for the bot; other requests are withdrawn.
  if (request.op !== 'send') await withdraw(id)
  let state = ''
  try {
    const status = JSON.parse(readFileSync(join(dataDir(), 'status.json'), 'utf8'))
    state = ` (last state: ${status.state}${status.detail ? `, ${status.detail}` : ''})`
  } catch {
    // No status yet.
  }
  process.stderr.write(`The Delta Chat bot did not answer in time${state}.${request.op === 'send' ? ' The message stays queued and goes out when the bot runs.' : ''}\n`)
  process.exit(3)
}
if (!result.ok) {
  process.stderr.write(`${result.error}\n`)
  process.exit(1)
}
if (command === 'invite') process.stdout.write(`${result.result.link}\nQR code: ${result.result.svgPath}\n`)
else process.stdout.write(`${JSON.stringify(result.result, null, 2)}\n`)
