# Changelog

## 0.2.0

- Working signs: each message the bot takes gets a ⏳ reaction (👀 when it joins a running turn), removed once the answer is sent, also after a failure, `/stop`, `/clear` or a restart.
- Helper activity: subagents a chat's turn starts are listed in one status message, edited in place as they start and finish; `/agents` lists the session's helpers with their last reports.
- A turn woken by a helper's report answers the chat whose turn started the helper, also with `mirrorTurns` off.
- A session's text-only `deltachat_send` into its own chat is refused, so answers no longer arrive twice; text sent there with files is not repeated in the answer.

## 0.1.0

First release: a Delta Chat bot for DSH on several chatmail relays, with a key-fingerprint allowlist, one session per chat (groups included), steering, mirrored turns, pictures, files, voice transcription, quotes, reactions, agent questions and tool approvals, Telegram-style commands, `DeltaChat-<person>-<task>` session titles, the `deltachatChats` send service, the `deltachat_send` tool and the `dsh-deltachat` command.
