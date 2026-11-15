# dsh-deltachat-bot

Feature-complete; no longer maintained. Forks welcome.

Use [Delta Chat](https://delta.chat) to reach sessions in your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Within DSH, the plugin runs a Delta Chat bot: it creates its own chatmail address (end-to-end encrypted; no phone number or sign-up needed), keeps that address on several relays so it stays reachable when a relay goes down, and ties each Delta Chat chat to a DSH session. Message it just as you would in the Web UI; answers, files and images come back to you as messages.

## Installation

Use the DSH Plugins page, or install from a shell:

```sh
dsh plugin --profile web add @soffits/dsh-deltachat-bot
```

You need Node.js 22 or newer. A prebuilt npm binary (`@deltachat/stdio-rpc-server`) provides the Delta Chat core for Linux, macOS and Windows on x64 and arm64; nothing is compiled.

The bundle adds two plugin rows: `deltachat-bot` (the bot itself) and `deltachat-bot-tools` (which gives agents the `deltachat_send` tool).

## First start

On the first start, the bot creates a Delta Chat profile on the relays named in `relays` (by default [nine.testrun.org](https://nine.testrun.org), the usual relay for Delta Chat apps, and [chtml.ca](https://chtml.ca)). This takes a few seconds. It then produces a QR code plus an invite link:

```sh
dsh-deltachat invite          # prints the link; the QR code is $DSH_HOME/deltachat/invite.svg
```

Open the link on a phone that has Delta Chat installed, or scan the QR code on the app's "New chat" screen. The app and the bot exchange keys, and the chat appears.

## Who may talk to it

Nobody can, unless you allow it. Only keys listed in `allowedUsers` get replies from the bot; all others are ignored and receive nothing. People are identified by their key fingerprint, not their address, because an address changes when someone adds a relay or switches to another.

To give yourself access, message the bot once, then ask it which contacts it ignored:

```sh
dsh-deltachat status          # "pending" lists ignored contacts with their fingerprints
dsh-deltachat allow "3C1F 9E0A 5B7D 2468 ACE0 1357 9BDF 0246 8ACE 1357" --name Alex
```

`allow` stores the entry through DSH's configuration editor, exactly as the settings page would. You can also add it to the profile by hand:

```yaml
- id: deltachat-bot
  config:
    allowedUsers:
      - fingerprint: 3C1F9E0A5B7D2468ACE013579BDF02468ACE1357
        name: Alex
```

Your fingerprint is also the part after `#` in the invite link for your own Delta Chat account. If you want the bot to start the chat, supply your invite link after your key is allowed:

```sh
dsh-deltachat join "https://i.delta.chat/#3C1F9E0A...&a=you%40relay.example&n=Alex"
```

Every message the agent receives starts with a line the bot adds from the sender's verified key, such as `[Delta Chat message from Alex (key 3C1F…, chat 10, message 42)]`. No text in the message can change that line.

## Chats and sessions

- The first message in a chat starts a new session in `cwd`. Each group you create with the bot gets its own session, much like a separate topic.
- Session titles use `DeltaChat-<person>-<task>`: the other party in the chat (a group's name, for a group) plus either the conversation title DSH produces or the chat's name until that title exists. A person's name comes from `peopleFile` when configured, else from `allowedUsers`, else from their Delta Chat profile.
- Delta Chat has no typing indicator, so the bot reacts ⏳ to your message as soon as it takes it and removes the reaction once the answer is sent (also when the turn fails or is stopped, and after a restart).
- If a message arrives while a turn is running, it joins that turn, as in the Web UI (`busyMessages: steer`), and shows 👀 until that turn ends. With `busyMessages: queue`, it waits for the turn to finish and keeps ⏳ until its own turn is answered.
- Turns started elsewhere (scheduled tasks, the Web UI) also show up in the chat unless `mirrorTurns` is off.
- When the turn ends, replies arrive as plain text: Delta Chat apps do not render Markdown, so the bot turns it into readable text. Files the agent presents, and local images inside an answer, are sent as files. An answer that is exactly `[SILENT]` sends nothing.
- The model receives images you send as images; other files come through as attachments. Voice messages are transcribed by DSH's speech-to-text service (or by a command you choose; see `transcriber`) and attached.
- When the agent starts helpers (subagents) during a turn the chat receives, one status message lists them with their model and running time, and is edited as each one starts and finishes; `/agents` lists the session's helpers with their last reports.
- Quoting a message tells the agent what you are replying to. A reaction to the bot's message is saved in the session but does not begin a turn.
- When the agent asks a question, the options show as a numbered list: answer with a number or in your own words. A tool that needs approval waits for `/allow` or `/deny`.

### Commands

Send these as messages; Delta Chat apps make them tappable.

| Command | Result |
|---|---|
| `/help` | List commands |
| `/new` | Start a fresh session here; the old one stays in DSH |
| `/stop` | Stop the running turn |
| `/clear` | Drop any messages waiting in the session queue |
| `/status` | Bot, relay and session status |
| `/current` | Show this chat's session |
| `/last [1-5]` | Show the latest answers |
| `/agents` | List the session's helpers and their last reports |
| `/sessions` | List workspaces; `/sessions 2` displays workspace 2's sessions; `/sessions 2 3` brings session 3 into this chat (`0` opens a new one) |
| `/workspace <n>` | Open a fresh session in workspace n |
| `/fork [name]` | Make a new group with the same people and fork the session there |
| `/rename <name>` | In a group chat, change the group's name; in a one-to-one chat, change the session title |
| `/goal …` | Goal actions: `/goal <objective>`, `/goal edit <objective>`, `pause`, `resume`, `clear` |
| `/menu` | See the model, effort level, access setting and context together |
| `/model` | List providers; `/model 2` lists models from that provider; `/model 2 5` picks one |
| `/effort`, `/mode` | Works the same way for effort level and access setting |
| `/context` | Context use for the session |
| `/allow`, `/deny` | Answer a tool approval that is waiting |
| `/invite` | Show the invite link for the bot |
| `/id` | Show your key, the bot's key and the chat id |
| `/ping` | Check whether the bot answers |
| `/restart` | Reconnect to Delta Chat |

A message that starts with `/` yet matches no command above (a path, for example) goes to the session as normal text.

## Sending from scripts, agents and additional plugins

Other plugins send through the `deltachatChats` Host service:

```js
await ctx.get('deltachatChats').send({
  to: 10,                       // chat id (/id in the chat shows it)
  text: 'Build finished',       // Markdown; made plain
  files: ['/abs/path/log.txt'],
  from: { job: 'nightly build' }, // or { sessionId } or { label }
  replyTo: 42,                  // optional: quote a message
})
```

Errors a retry cannot solve carry `retryable: false`. The message is also recorded in the session tied to that chat, without starting a turn, so the agent knows it went out; if the person quotes it later, the agent can tell which job or session sent it. `chats()` lists chats bound to sessions, and `invite()` returns the invite link.

Agents can use the `deltachat_send` tool, which offers the same options (plus `reaction` to react to a message). A session's answer already goes to its own chat, so the tool refuses text-only sends from a session into the chat it is bound to, and text it sent there with files is not repeated in the answer. From a shell:

```sh
dsh-deltachat send --chat 10 --job backup "Backup done"
dsh-deltachat send --chat 10 --file /tmp/report.pdf
dsh-deltachat react --chat 10 --reply-to 42 👍
dsh-deltachat chats
```

The command line talks to the running bot through a spool directory under `$DSH_HOME/deltachat`, so it needs no network access to DSH. A send made while DSH is stopped waits there and is delivered when the bot starts.

## Configuration

| Field | Default | |
|---|---|---|
| `enabled` | `true` | Whether the bot is active |
| `displayName` | `DSH` | Name shown in Delta Chat |
| `avatar` | | Full path of an image to use as the bot avatar |
| `relays` | `[nine.testrun.org, chtml.ca]` | Chatmail relays, given by domain. A relay added here joins the bot's profile; one removed here stays in the profile |
| `allowedUsers` | `[]` | Items shaped like `{ fingerprint, name }` |
| `peopleFile` | | JSON file with a `deltachat_keys` object mapping fingerprints to names, for session titles |
| `cwd` | DSH's directory | Directory where new sessions start |
| `agentPreset` | | Preset for new sessions; blank uses the default |
| `mirrorTurns` | `true` | Show turns started elsewhere |
| `busyMessages` | `steer` | `steer` or `queue` |
| `transcriber` | `dsh` | `dsh`, `command` or `off` |
| `transcribeLanguage` | | Language hint for DSH speech-to-text |
| `transcribeCommand` | `[]` | Program and arguments; `{file}` is the recording |
| `ffmpegPath` | `ffmpeg` | Decodes audio for DSH speech-to-text |

Every field applies live: changing one needs no DSH restart. Relays, name and avatar take effect at once.

Pick relays you expect to stay up; the [chatmail relay list](https://chatmail.at/relays) has many. Relays remove accounts after about 90 days without a login, which a running bot never allows to happen.

## Where files live

Everything is stored under `$DSH_HOME/deltachat/`:

- `accounts/` holds the Delta Chat profile, with the bot's private key and its message database. Keep it out of shared backups outside your control, and keep it when moving DSH: otherwise the bot gets a fresh address and key, and people have to scan a fresh invite.
- `state.json`: chat-to-session bindings, ignored contacts, and a log of messages sent by jobs and sessions.
- `status.json`: the bot's state and latest error, for diagnostics.
- `invite.txt`, `invite.svg`: the invite link and its QR code.
- `spool/`: requests that come from the command line.

The bot's log lines appear in DSH's output prefixed with `[dsh-deltachat-bot]`.

## Updates and removal

Update it like any DSH plugin. Every release locks the Delta Chat core at a tested version.

To remove it, remove the bundle from DSH, then delete `$DSH_HOME/deltachat/` unless you want to keep the bot's identity. Anyone who chatted with it can remove the chat in their app.

## Troubleshooting

- **No reply from the bot.** `dsh-deltachat status` shows whether it runs and lists ignored contacts; the common cause is an entry missing from `allowedUsers`. DSH's log contains lines prefixed `[dsh-deltachat-bot]`.
- **"no relay could create the Delta Chat profile".** None of the relays in `relays` could be reached or would take a new account. Try a different relay from the [relay list](https://chatmail.at/relays).
- **Core stopped.** The bot restarts it with a growing delay (5 s up to 5 min) and logs why it stopped.

## Development

```sh
npm install
npm test          # unit and bridge tests against a fake core and a fake Host
npm run e2e       # real relays: a bot and two throwaway accounts, all deleted afterwards
```

Each `npm run e2e` run creates fresh accounts on public relays; run it when message handling or the core changes, not over and over. Set `E2E_BOT_RELAYS` and `E2E_TESTER_RELAY` to choose other relays.

## License

MIT. The core packages from Delta Chat use MPL-2.0.
