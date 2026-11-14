/**
 * Chat commands. They follow the Telegram bot's commands; where Telegram
 * shows buttons, a command lists numbered choices and the same command with
 * the number picks one (`/model` lists providers, `/model 2` its models,
 * `/model 2 5` selects). Delta Chat apps make `/command` words tappable in
 * bot chats.
 */
import { basename } from 'node:path'
import { messageData } from './core.js'
import { allowedEntry, vcardFingerprint } from './identity.js'
import { CONTROL_HANDLERS, liveAgent, pick, sessionOf } from './controls.js'
import { clearChatInbox, controllerOf, listWorkspaces, recentAssistantTexts, sessionTitle, sessionsInWorkspace } from './sessions.js'
import { clip, toPlainText } from './text.js'
import { chatTitle } from './titles.js'

/** Commands and their help lines, in the order /help shows them. */
export const COMMANDS = [
  ['help', 'List commands'],
  ['new', 'Start a new session in this chat'],
  ['stop', 'Stop the running turn'],
  ['clear', 'Drop messages still waiting for the session'],
  ['status', 'Bot and session status'],
  ['current', "Show this chat's session"],
  ['last', 'Show the latest answers: /last [1-5]'],
  ['sessions', 'Browse workspaces and sessions, continue one here'],
  ['workspace', 'Start a new session in another workspace'],
  ['fork', 'Fork this session into a new group: /fork [name]'],
  ['rename', "Rename this chat's session (and the group)"],
  ['goal', 'Goal: /goal <objective>, edit, pause, resume, clear'],
  ['menu', 'Model, effort, access mode and context'],
  ['model', 'Choose the model'],
  ['effort', 'Choose the reasoning effort'],
  ['mode', 'Choose the access mode'],
  ['context', 'Context use of the session'],
  ['allow', 'Allow the waiting tool request'],
  ['deny', 'Deny the waiting tool request'],
  ['invite', "Show the bot's invite link"],
  ['id', 'Show chat and key ids'],
  ['ping', 'Check that the bot answers'],
  ['restart', 'Restart the Delta Chat connection'],
]

const NAMES = new Set([...COMMANDS.map(([command]) => command), 'start'])

/** Workspaces and sessions listed at most. */
const LIST_LIMIT = 15

/**
 * Read a command from a message.
 * @param text - message text.
 * @returns `{ name, args }`, or undefined when the text is not a known command
 *   (a path such as `/home/...` stays an ordinary message).
 */
export function parseCommand(text) {
  const match = String(text ?? '').trim().match(/^\/([A-Za-z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/u)
  if (match === null) return undefined
  const name = match[1].toLowerCase()
  if (!NAMES.has(name)) return undefined
  return { name: name === 'start' ? 'help' : name, args: (match[2] ?? '').trim() }
}

/** @returns the help text. */
export function helpText() {
  return ['Commands:', ...COMMANDS.map(([command, line]) => `/${command} — ${line}`), '', 'Anything else you write goes to this chat\'s DSH session.'].join('\n')
}

/** @returns a relative age, such as "5 min ago". */
function age(timestamp) {
  if (typeof timestamp !== 'number') return ''
  const minutes = Math.round((Date.now() - timestamp) / 60_000)
  if (minutes < 60) return `${Math.max(0, minutes)} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/**
 * Run one command.
 * @param bridge - runtime handles from app.js.
 * @param from - `{ chatId, chatInfo, sender, msgId }`.
 * @param command - `{ name, args }`.
 */
export async function runCommand(bridge, from, command) {
  const handler = HANDLERS[command.name]
  await handler(bridge, from, command.args)
}

function isRunning(agent) {
  return agent !== undefined && agent.status !== undefined && agent.status !== 'idle'
}

/** Refuse a command while the chat's session runs a turn. */
async function refuseWhileRunning(bridge, chatId, what) {
  if (!isRunning(liveAgent(bridge, chatId))) return false
  await bridge.notice(chatId, `Stop the running turn first (/stop), then ${what}.`)
  return true
}

/** Start the chat's next session in a directory, keeping the old one in DSH. */
async function startFresh(bridge, chatId, cwd) {
  const store = bridge.store()
  const previous = await store.release(chatId)
  const record = store.data.chats[String(chatId)] ?? {}
  store.data.chats[String(chatId)] = { ...record, cwd }
  await store.save()
  const title = previous === undefined ? undefined : await sessionTitle(bridge.ctx, previous)
  return title
}

/** Text of a goal's state. */
function goalStatus(view) {
  if (view === undefined) return '🎯 No goal is set.\n\n/goal <objective> sets one.'
  const phase = view.activation === 'armed' || view.phase !== 'active' ? view.phase : `${view.phase}, not armed`
  return `🎯 Goal (${phase}, round ${view.roundsStarted}/${view.maxGoalRounds}):\n${view.objective}\n\n/goal edit <objective> · /goal pause · /goal resume · /goal clear`
}

const HANDLERS = {
  async help(bridge, { chatId }) {
    await bridge.notice(chatId, helpText())
  },

  async ping(bridge, { chatId }) {
    await bridge.notice(chatId, 'pong')
  },

  async id(bridge, { chatId, chatInfo, sender }) {
    const { dc, accountId } = bridge.runtime()
    const vcard = await dc.rpc.makeVcard(accountId, [1]).catch(() => '')
    const own = vcardFingerprint(vcard)
    await bridge.notice(chatId, [
      `Chat: ${chatId} (${chatInfo.chatType}, "${chatInfo.name}")`,
      `Your key: ${sender.fingerprint}`,
      ...(own ? [`Bot key: ${own}`] : []),
      `Session: ${sessionOf(bridge, chatId) ?? 'none yet'}`,
    ].join('\n'))
  },

  async status(bridge, { chatId }) {
    const facts = await bridge.describe()
    const agent = liveAgent(bridge, chatId)
    const sessionId = sessionOf(bridge, chatId)
    const lines = [
      `Delta Chat bot: ${facts.running ? 'running' : facts.state}`,
      ...(facts.running ? [
        `Address: ${facts.primary}`,
        `Relays: ${facts.relays.map((addr) => addr.split('@')[1]).join(', ')}`,
        `Connectivity: ${facts.connectivity >= 4000 ? 'connected' : facts.connectivity >= 3000 ? 'working' : facts.connectivity >= 2000 ? 'connecting' : 'offline'}`,
        `Uptime: ${Math.round(facts.uptimeSeconds / 60)} min`,
        `Allowed people: ${facts.allowedUsers}${facts.pending.length > 0 ? `, ${facts.pending.length} ignored contact(s)` : ''}`,
      ] : []),
      `Session: ${sessionId ?? 'none yet'}`,
      ...(sessionId === undefined ? [] : [`Title: ${await sessionTitle(bridge.ctx, sessionId)}`]),
      `Agent: ${isRunning(agent) ? 'running' : 'idle'}`,
    ]
    const asked = bridge.prompts.pending(chatId)
    if (asked.question) lines.push('A question is waiting for your answer.')
    if (asked.approvals > 0) lines.push(`${asked.approvals} tool request(s) wait for /allow or /deny.`)
    await bridge.notice(chatId, lines.join('\n'))
  },

  async current(bridge, { chatId }) {
    const sessionId = sessionOf(bridge, chatId)
    if (sessionId === undefined) {
      await bridge.notice(chatId, 'This chat has no session yet; your next message starts one.')
      return
    }
    const record = bridge.store().chat(chatId)
    await bridge.notice(chatId, `${await sessionTitle(bridge.ctx, sessionId)}\nSession: ${sessionId}\nWorkspace: ${record?.cwd ?? '?'}`)
  },

  async new(bridge, { chatId }) {
    if (await refuseWhileRunning(bridge, chatId, 'start a new session')) return
    const record = bridge.store().chat(chatId)
    const previous = await startFresh(bridge, chatId, record?.cwd ?? bridge.setting('cwd', process.cwd()))
    await bridge.notice(chatId, `🆕 New session: your next message starts it.${previous === undefined ? '' : `\nThe previous session stays in DSH: ${previous}`}`)
  },

  async stop(bridge, { chatId }) {
    const agent = liveAgent(bridge, chatId)
    bridge.prompts.cancelChat(chatId)
    if (!isRunning(agent)) {
      await bridge.notice(chatId, 'Nothing is running.')
      return
    }
    const turn = bridge.currentTurn(agent.session?.id ?? agent.id)
    if (turn !== undefined) turn.stopped = true
    try {
      agent.inbox?.clear?.()
    } catch {
      // Inbox unavailable.
    }
    try {
      agent.cancel({ kind: 'user' })
    } catch {
      // Already idle.
    }
    await bridge.notice(chatId, '⏹ Stopped.')
  },

  async clear(bridge, { chatId }) {
    const removed = clearChatInbox(liveAgent(bridge, chatId), chatId)
    await bridge.notice(chatId, removed === 0 ? '🧹 Nothing is waiting.' : `🧹 Dropped ${removed} waiting message(s).`)
  },

  async last(bridge, { chatId }, args) {
    const sessionId = sessionOf(bridge, chatId)
    if (sessionId === undefined) {
      await bridge.notice(chatId, 'This chat has no session yet.')
      return
    }
    const requested = Number.parseInt(args || '1', 10)
    const limit = Number.isFinite(requested) ? Math.min(5, Math.max(1, requested)) : 1
    const texts = await recentAssistantTexts(bridge.ctx, sessionId, limit)
    if (texts.length === 0) {
      await bridge.notice(chatId, 'This session has no answers yet.')
      return
    }
    for (const [index, text] of [...texts].reverse().entries()) {
      const label = texts.length === 1 ? 'Latest answer' : `Answer ${index + 1}/${texts.length}`
      await bridge.notice(chatId, `${label}:\n\n${toPlainText(text)}`)
    }
  },

  async sessions(bridge, { chatId }, args) {
    const workspaces = listWorkspaces(bridge.ctx).slice(0, LIST_LIMIT)
    const [first, second] = args.split(/\s+/u).filter(Boolean)
    if (first === undefined) {
      if (workspaces.length === 0) {
        await bridge.notice(chatId, 'No workspaces are registered.')
        return
      }
      const here = bridge.store().chat(chatId)?.cwd
      await bridge.notice(chatId, [
        'Workspaces:',
        ...workspaces.map((workspace, index) => `${index + 1}. ${workspace.title || basename(workspace.path)} (${workspace.path})${workspace.path === here ? ' ✅' : ''}`),
        '',
        '/sessions <n> lists the sessions of workspace n.',
      ].join('\n'))
      return
    }
    const workspace = pick(workspaces, first)
    if (workspace === undefined) {
      await bridge.notice(chatId, `No workspace ${first}; /sessions lists them.`)
      return
    }
    const records = await sessionsInWorkspace(bridge.ctx, workspace, LIST_LIMIT, bridge.signal)
    if (second === undefined) {
      const store = bridge.store()
      const lines = [`Sessions in ${workspace.title || basename(workspace.path)}:`, '0. New session']
      for (const [index, record] of records.entries()) {
        const id = record.header.id
        const boundTo = store.chatOfSession(id)
        const mark = boundTo === chatId ? ' ✅' : boundTo !== undefined ? ' 🔗' : ''
        lines.push(`${index + 1}. ${clip(await sessionTitle(bridge.ctx, id, record.header), 60)} · ${age(record.header.createdAt)}${mark}`)
      }
      lines.push('', `/sessions ${first} <n> continues session n in this chat (0 starts a new one). 🔗 means another chat shows it now; it moves here.`)
      await bridge.notice(chatId, lines.join('\n'))
      return
    }
    if (await refuseWhileRunning(bridge, chatId, 'switch sessions')) return
    if (second === '0' || second === 'new') {
      await startFresh(bridge, chatId, workspace.path)
      await bridge.notice(chatId, `🆕 Your next message starts a new session in ${workspace.title || basename(workspace.path)}.`)
      return
    }
    const record = pick(records, second)
    if (record === undefined) {
      await bridge.notice(chatId, `No session ${second}; /sessions ${first} lists them.`)
      return
    }
    const sessionId = record.header.id
    await bridge.store().bind(chatId, { sessionId, cwd: record.header.cwd ?? workspace.path })
    await bridge.ensureAgent(chatId)
    await bridge.notice(chatId, `✅ This chat now continues: ${await sessionTitle(bridge.ctx, sessionId, record.header)}`)
  },

  async workspace(bridge, from, args) {
    if (args.length === 0) {
      await HANDLERS.sessions(bridge, from, '')
      await bridge.notice(from.chatId, '/workspace <n> starts a new session in workspace n.')
      return
    }
    await HANDLERS.sessions(bridge, from, `${args.split(/\s+/u)[0]} new`)
  },

  async fork(bridge, { chatId }, args) {
    const sessionId = sessionOf(bridge, chatId)
    if (sessionId === undefined) {
      await bridge.notice(chatId, 'This chat has no session to fork yet.')
      return
    }
    if (await refuseWhileRunning(bridge, chatId, 'fork')) return
    const controller = controllerOf(bridge.ctx)
    if (typeof controller?.fork !== 'function') {
      await bridge.notice(chatId, 'Forking is not available in this DSH.')
      return
    }
    const result = await controller.fork({ sessionId })
    const forkId = typeof result === 'string' ? result : result?.sessionId
    if (typeof forkId !== 'string') throw new Error('The fork returned no session id.')
    const title = clip(args.replace(/^["']|["']$/gu, '').trim() || `Fork of ${await sessionTitle(bridge.ctx, sessionId)}`, 100)
    const { dc, accountId, fingerprints } = bridge.runtime()
    const allowed = bridge.setting('allowedUsers', [])
    const groupId = await dc.rpc.createGroupChat(accountId, title, false)
    for (const contactId of await dc.rpc.getChatContacts(accountId, chatId)) {
      if (contactId <= 9) continue
      if (allowedEntry(allowed, await fingerprints.get(contactId)) !== undefined) await dc.rpc.addContactToChat(accountId, groupId, contactId)
    }
    const record = bridge.store().chat(chatId)
    await bridge.store().bind(groupId, { sessionId: forkId, cwd: record?.cwd })
    await bridge.store().describeChat(groupId, { person: title, chatName: title, titlePersons: [record?.person].filter(Boolean) })
    await bridge.ensureAgent(groupId)
    await bridge.applyTitle(forkId)
    await dc.rpc.sendMsg(accountId, groupId, messageData({ text: `🔀 This group continues a fork of "${await sessionTitle(bridge.ctx, sessionId)}". The original stays in the chat it came from.` }))
    await bridge.notice(chatId, `🔀 Forked into the new group "${title}".`)
  },

  async rename(bridge, { chatId, chatInfo }, args) {
    const sessionId = sessionOf(bridge, chatId)
    const name = args.trim()
    if (name.length === 0 || name.length > 120) {
      await bridge.notice(chatId, 'Usage: /rename <new name> (at most 120 characters)')
      return
    }
    // A group is renamed, and its session's title follows; in a one-to-one
    // chat the session's conversation title is set.
    if (chatInfo.chatType === 'Group') {
      const { dc, accountId } = bridge.runtime()
      await dc.rpc.setChatName(accountId, chatId, name)
      await bridge.store().describeChat(chatId, { person: name, chatName: name })
      if (sessionId !== undefined) await bridge.applyTitle(sessionId)
      await bridge.notice(chatId, `✏️ Group renamed to "${name}".`)
      return
    }
    if (sessionId === undefined) {
      await bridge.notice(chatId, 'This chat has no session to rename yet.')
      return
    }
    const record = bridge.store().chat(chatId)
    const title = chatTitle(record?.person ?? chatInfo.name, name)
    const service = bridge.ctx.get('sessionTitle')
    const session = (await bridge.ensureAgent(chatId)).session
    if (service !== undefined) service.rename(session, title)
    else await controllerOf(bridge.ctx)?.rename?.({ sessionId, title })
    await bridge.notice(chatId, `✏️ Session renamed to "${title}".`)
  },

  async goal(bridge, { chatId }, args) {
    const goals = bridge.ctx.get('goals')
    if (goals === undefined) {
      await bridge.notice(chatId, 'Goals are not available in this DSH.')
      return
    }
    const agent = await bridge.ensureAgent(chatId, { claim: true })
    const [action = ''] = args.split(/\s+/u)
    const verb = action.toLowerCase()
    let view = goals.get(agent)
    if (args.length === 0) {
      await bridge.notice(chatId, goalStatus(view))
      return
    }
    if (verb === 'clear' || verb === 'delete') {
      if (view !== undefined) goals.clear(agent, { id: view.id, revision: view.revision })
      await bridge.notice(chatId, view === undefined ? '🎯 No goal to clear.' : '🎯 Goal cleared.')
      return
    }
    if (verb === 'pause') {
      if (view === undefined) {
        await bridge.notice(chatId, '🎯 No goal to pause.')
        return
      }
      view = goals.pause(agent, { id: view.id, revision: view.revision })
      await bridge.notice(chatId, goalStatus(view))
      return
    }
    if (verb === 'resume') {
      if (view === undefined || view.phase === 'complete') {
        await bridge.notice(chatId, view === undefined ? '🎯 No goal is set.' : '🎯 The goal is already complete.')
        return
      }
      if (!(view.phase === 'active' && view.activation === 'armed')) view = goals.resume(agent, { id: view.id, revision: view.revision })
      await bridge.notice(chatId, goalStatus(view))
      return
    }
    const objective = verb === 'edit' || verb === 'set' ? args.slice(action.length).trim() : args
    if (objective.length === 0) {
      await bridge.notice(chatId, 'Usage: /goal <objective>')
      return
    }
    if (view !== undefined && view.phase !== 'complete') {
      view = goals.edit(agent, { id: view.id, revision: view.revision }, { objective })
      if (view.phase !== 'active' || view.activation !== 'armed') {
        try {
          view = goals.resume(agent, { id: view.id, revision: view.revision })
        } catch (error) {
          bridge.warn(`goal resume after edit failed: ${error?.message ?? error}`)
        }
      }
    } else {
      if (view !== undefined) goals.clear(agent, { id: view.id, revision: view.revision })
      view = goals.create(agent, { objective })
    }
    bridge.chatState(chatId).goalPhase = view.phase
    await bridge.notice(chatId, goalStatus(view))
  },

  ...CONTROL_HANDLERS,

  async allow(bridge, { chatId }) {
    const tool = bridge.prompts.settleApproval(chatId, true)
    await bridge.notice(chatId, tool === undefined ? 'No tool request is waiting.' : `✅ Allowed ${tool}.`)
  },

  async deny(bridge, { chatId }) {
    const tool = bridge.prompts.settleApproval(chatId, false)
    await bridge.notice(chatId, tool === undefined ? 'No tool request is waiting.' : `❌ Denied ${tool}.`)
  },

  async invite(bridge, { chatId }) {
    const { link } = await bridge.invite()
    await bridge.notice(chatId, `Invite link of this bot (people still need to be in allowedUsers to talk to it):\n${link}`)
  },

  async restart(bridge, { chatId }) {
    await bridge.notice(chatId, '♻️ Restarting the Delta Chat connection…')
    bridge.restart('command')
  },
}

