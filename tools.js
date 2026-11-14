/**
 * Model-facing tool for the Delta Chat bot. A separate plugin entry from the
 * bot (index.js): the bot is looked up as the `deltachatChats` service at call
 * time, so reloading or restarting the bot never unregisters the tool.
 */
import z from '@deepseek-ai/schemastery'
import { SERVICE_NAME } from './src/constants.js'

export const name = 'deltachat-bot-tools'
export const inject = ['tools']
export const Config = z.object({})

/** JSON Schema of the send tool's arguments. */
export const SEND_SCHEMA = {
  type: 'object',
  properties: {
    chat: { type: 'string', description: 'Numeric Delta Chat chat id; each message from a chat names it in its sender line, and /id in the chat shows it.' },
    text: { type: 'string', description: 'Message text; Markdown is turned into plain text.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of files to send.' },
    reply_to: { type: 'string', description: 'Message id to quote (or to react to, with reaction).' },
    reaction: { type: 'string', description: 'An emoji to react to reply_to with instead of sending a message; an empty string removes the reaction.' },
  },
  required: ['chat'],
  additionalProperties: false,
}

/**
 * The send tool.
 * @param getService - returns the running bot's service, or undefined.
 * @returns a tool definition.
 */
export function createSendTool(getService) {
  return {
    name: 'deltachat_send',
    description: 'Send a message, files or a reaction into a Delta Chat chat of the DSH Delta Chat bot, addressed by its numeric chat id. Not for answering a Delta Chat message in its own session: the final answer of the turn is delivered there by itself. Use it to reach a chat from another session or a job, to send files, or to react to a message. The message is also recorded in the session bound to that chat; no turn is started.',
    parameters: SEND_SCHEMA,
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      const service = getService()
      if (service === undefined) return { code: 'unavailable', message: 'The Delta Chat bot is not running.' }
      const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
      try {
        return await service.send({
          to: args?.chat,
          text: typeof args?.text === 'string' ? args.text : '',
          files: Array.isArray(args?.files) ? args.files : [],
          ...(args?.reply_to === undefined ? {} : { replyTo: args.reply_to }),
          ...(typeof args?.reaction === 'string' ? { reaction: args.reaction } : {}),
          from: typeof sessionId === 'string' ? { sessionId, label: `session ${sessionId}` } : undefined,
        })
      } catch (error) {
        return { code: 'failed', message: error?.message ?? String(error) }
      }
    },
  }
}

export function apply(ctx) {
  ctx.tools.register(createSendTool(() => ctx.get(SERVICE_NAME)))
}
