import http from 'http';
import https from 'https';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

async function transcribeVoice(
  audioBuffer: Buffer,
  filename: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const sep = String.fromCharCode(13, 10);
    const boundary = '----WhisperBoundary' + Date.now().toString(16);
    const modelPart = Buffer.from(
      '--' +
        boundary +
        sep +
        'Content-Disposition: form-data; name="model"' +
        sep +
        sep +
        'Systran/faster-whisper-small' +
        sep,
      'utf8',
    );
    const fileHeader = Buffer.from(
      '--' +
        boundary +
        sep +
        'Content-Disposition: form-data; name="file"; filename="' +
        filename +
        '"' +
        sep +
        'Content-Type: audio/ogg' +
        sep +
        sep,
      'utf8',
    );
    const footer = Buffer.from(sep + '--' + boundary + '--' + sep, 'utf8');
    const body = Buffer.concat([modelPart, fileHeader, audioBuffer, footer]);
    const req = http.request(
      {
        hostname: '46.62.246.93',
        port: 9000,
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': body.length,
          Accept: 'application/json',
        },
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: any) => chunks.push(c));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 200) {
            try {
              resolve(
                (JSON.parse(rawBody) as { text: string }).text.trim() || null,
              );
            } catch {
              resolve(rawBody.trim() || null);
            }
          } else {
            logger.warn(
              { status: res.statusCode, body: rawBody.slice(0, 200) },
              'Whisper transcription error',
            );
            resolve(null);
          }
        });
      },
    );
    req.on('error', (err: any) => {
      logger.warn({ err: err.message }, 'Whisper request error');
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}
async function downloadTelegramFile(
  token: string,
  fileId: string,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const api = new Api(token);
    api
      .getFile(fileId)
      .then((file) => {
        if (!file.file_path) {
          resolve(null);
          return;
        }
        const url =
          'https://api.telegram.org/file/bot' + token + '/' + file.file_path;
        const urlObj = new URL(url);
        const options = {
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
        };
        https
          .get(options, (res: any) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: any) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', () => resolve(null));
          })
          .on('error', () => resolve(null));
      })
      .catch(() => resolve(null));
  });
}

const ACK_MESSAGES = [
  'Понял, работаю над этим...',
  'Принято! Сейчас разберусь.',
  'Хорошо, уже думаю над этим.',
  'Окей, обрабатываю твой запрос.',
  'Понял тебя, сейчас отвечу.',
  'Получил! Дай мне секунду.',
  'Уже занимаюсь этим.',
  'Принял задачу, думаю...',
];

function randomAck(): string {
  return ACK_MESSAGES[Math.floor(Math.random() * ACK_MESSAGES.length)];
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to show help
    this.bot.command('help', (ctx) => {
      ctx.reply(
        `*Команды бота:*

` +
          `/ping — проверить что бот онлайн
` +
          `/chatid — получить ID этого чата
` +
          `/help — показать это сообщение

` +
          `*Как общаться:*
` +
          `Напиши *@Andy* + вопрос или задание
` +
          `Отправь голосовое сообщение — бот транскрибирует и ответит

` +
          `*Примеры:*
` +
          `@Andy найди информацию о...
` +
          `@Andy напиши письмо...
` +
          `@Andy переведи текст...`,
        { parse_mode: 'Markdown' },
      );
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      let isBotMentioned = false;
      if (botUsername) {
        const entities = ctx.message.entities || [];
        isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      // Send acknowledgement so user knows the bot is processing
      const isPrivate = ctx.chat.type === 'private';
      if (isPrivate || TRIGGER_PATTERN.test(content) || isBotMentioned) {
        ctx.reply(randomAck()).catch(() => {});
      }

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const fileId = ctx.message.voice?.file_id;
      if (fileId) {
        try {
          const buf = await downloadTelegramFile(this.botToken, fileId);
          if (buf) {
            const transcript = await transcribeVoice(buf, 'voice.ogg');
            if (transcript) {
              storeNonText(ctx, transcript);
              ctx.reply('🎤 «' + transcript + '»').catch(() => {});
              return;
            }
          }
        } catch (e: any) {
          logger.warn(
            { err: e.message },
            'Voice transcription failed, using placeholder',
          );
        }
      }
      storeNonText(ctx, '[Voice message]');
    });
    this.bot.on('message:audio', async (ctx) => {
      const fileId = ctx.message.audio?.file_id;
      if (fileId) {
        try {
          const buf = await downloadTelegramFile(this.botToken, fileId);
          if (buf) {
            const transcript = await transcribeVoice(buf, 'audio.mp3');
            if (transcript) {
              storeNonText(ctx, transcript);
              return;
            }
          }
        } catch (e: any) {
          logger.warn(
            { err: e.message },
            'Audio transcription failed, using placeholder',
          );
        }
      }
      storeNonText(ctx, '[Audio]');
    });
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Register bot commands in Telegram menu
    await this.bot.api.setMyCommands([
      { command: 'ping', description: 'Проверить что бот онлайн' },
      { command: 'help', description: 'Показать список команд' },
      { command: 'chatid', description: 'Получить ID этого чата' },
    ]);

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
