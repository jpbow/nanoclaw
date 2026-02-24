import path from 'path';

import { Bot } from 'grammy';

import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
} from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudioBuffer } from '../transcription.js';
import { Channel, MessageAttachment, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Skip downloading files larger than this (20 MB)
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /** Download a file from the Telegram CDN. Returns null on failure or if too large. */
  private async downloadTgFile(
    fileId: string,
    fileSize?: number,
  ): Promise<{ buffer: Buffer; filePath: string } | null> {
    if (fileSize && fileSize > MAX_ATTACHMENT_BYTES) {
      logger.debug({ fileId, fileSize }, 'Skipping oversized Telegram attachment');
      return null;
    }
    try {
      const file = await this.bot!.api.getFile(fileId);
      if (!file.file_path) return null;
      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        logger.debug({ fileId, size: buffer.length }, 'Downloaded file exceeds limit, discarding');
        return null;
      }
      return { buffer, filePath: file.file_path };
    } catch (err) {
      logger.error({ err, fileId }, 'Failed to download Telegram file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

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

    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) return;

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

      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
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

      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid, chatName }, 'Message from unregistered Telegram chat');
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, chatName, sender: senderName }, 'Telegram message stored');
    });

    // Photo: download and attach
    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const msgId = ctx.message.message_id.toString();
      const caption = ctx.message.caption || '';

      // Telegram provides multiple sizes; last entry is the largest
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];

      let content = caption ? `[Photo]\n${caption}` : '[Photo]';
      const attachments: MessageAttachment[] = [];

      try {
        const downloaded = await this.downloadTgFile(photo.file_id, photo.file_size);
        if (downloaded) {
          const ext = path.extname(downloaded.filePath) || '.jpg';
          const filename = `tg_photo_${msgId}${ext}`;
          content = caption
            ? `[Photo: ${filename}]\n${caption}`
            : `[Photo: ${filename}]`;
          attachments.push({ filename, buffer: downloaded.buffer, mimeType: 'image/jpeg', placeholder: filename });
          logger.info({ chatJid, filename }, 'Telegram photo attachment downloaded');
        }
      } catch (err) {
        logger.error({ err }, 'Telegram photo download error');
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        ...(attachments.length ? { attachments } : {}),
      });
    });

    // Video: placeholder only (too large to download by default)
    this.bot.on('message:video', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const caption = ctx.message.caption ? `\n${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `[Video]${caption}`,
        timestamp,
        is_from_me: false,
      });
    });

    // Voice: transcribe as before
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';

      let content = '[Voice message]';
      try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const response = await fetch(url);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const transcript = await transcribeAudioBuffer(buffer);
          if (transcript) {
            content = `[Voice: ${transcript}]`;
            logger.info({ chatJid, length: content.length }, 'Transcribed Telegram voice message');
          }
        }
      } catch (err) {
        logger.error({ err }, 'Telegram voice transcription error');
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    // Audio file: download and attach
    this.bot.on('message:audio', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const audio = ctx.message.audio!;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const msgId = ctx.message.message_id.toString();
      const caption = ctx.message.caption || '';

      let content = caption ? `[Audio]\n${caption}` : '[Audio]';
      const attachments: MessageAttachment[] = [];

      try {
        const downloaded = await this.downloadTgFile(audio.file_id, audio.file_size);
        if (downloaded) {
          const ext = path.extname(downloaded.filePath) || '.mp3';
          const filename = `tg_audio_${msgId}${ext}`;
          content = caption
            ? `[Audio: ${filename}]\n${caption}`
            : `[Audio: ${filename}]`;
          attachments.push({ filename, buffer: downloaded.buffer, mimeType: audio.mime_type, placeholder: filename });
          logger.info({ chatJid, filename }, 'Telegram audio attachment downloaded');
        }
      } catch (err) {
        logger.error({ err }, 'Telegram audio download error');
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        ...(attachments.length ? { attachments } : {}),
      });
    });

    // Document: download and attach
    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const doc = ctx.message.document!;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const msgId = ctx.message.message_id.toString();
      const caption = ctx.message.caption || '';
      const originalName = doc.file_name || 'file';

      let content = caption
        ? `[Document: ${originalName}]\n${caption}`
        : `[Document: ${originalName}]`;
      const attachments: MessageAttachment[] = [];

      try {
        const downloaded = await this.downloadTgFile(doc.file_id, doc.file_size);
        if (downloaded) {
          // Sanitize filename to be filesystem-safe
          const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filename = `tg_doc_${msgId}_${safeName}`;
          content = caption
            ? `[Document: ${filename}]\n${caption}`
            : `[Document: ${filename}]`;
          attachments.push({ filename, buffer: downloaded.buffer, mimeType: doc.mime_type, placeholder: filename });
          logger.info({ chatJid, filename }, 'Telegram document attachment downloaded');
        }
      } catch (err) {
        logger.error({ err }, 'Telegram document download error');
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        ...(attachments.length ? { attachments } : {}),
      });
    });

    this.bot.on('message:sticker', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const emoji = ctx.message.sticker?.emoji || '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `[Sticker ${emoji}]`,
        timestamp,
        is_from_me: false,
      });
    });

    this.bot.on('message:location', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: '[Location]',
        timestamp,
        is_from_me: false,
      });
    });

    this.bot.on('message:contact', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: '[Contact]',
        timestamp,
        is_from_me: false,
      });
    });

    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
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
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
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

  async sendPhoto(jid: string, photo: Buffer, caption?: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const { InputFile } = await import('grammy');
      await this.bot.api.sendPhoto(numericId, new InputFile(photo), {
        caption: caption || undefined,
      });
      logger.info({ jid }, 'Telegram photo sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram photo');
    }
  }

  async sendDocument(jid: string, document: Buffer, filename: string, caption?: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const { InputFile } = await import('grammy');
      await this.bot.api.sendDocument(numericId, new InputFile(document, filename), {
        caption: caption || undefined,
      });
      logger.info({ jid, filename }, 'Telegram document sent');
    } catch (err) {
      logger.error({ jid, filename, err }, 'Failed to send Telegram document');
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
