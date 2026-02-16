import { App, LogLevel } from '@slack/bolt';

import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App | null = null;
  private opts: SlackChannelOpts;
  private botToken: string;
  private appToken: string;
  private botUserId: string | null = null;

  constructor(botToken: string, appToken: string, opts: SlackChannelOpts) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    // Resolve bot's own user ID so we can skip self-messages
    try {
      const authResult = await this.app.client.auth.test({ token: this.botToken });
      this.botUserId = authResult.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Slack bot identity resolved');
    } catch (err) {
      logger.warn({ err }, 'Could not resolve Slack bot user ID');
    }

    // Handle @mentions — always trigger regardless of requiresTrigger
    this.app.event('app_mention', async ({ event }) => {
      const chatJid = `slack:${event.channel}`;
      const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();
      const userId = event.user || '';
      const senderName = await this.resolveUserName(userId);

      // Strip the bot @mention from the text and prepend trigger
      let content = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      if (!TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      this.opts.onChatMetadata(chatJid, timestamp, await this.resolveChannelName(event.channel));

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid }, 'Mention from unregistered Slack channel');
        return;
      }

      this.opts.onMessage(chatJid, {
        id: event.ts,
        chat_jid: chatJid,
        sender: userId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, sender: senderName }, 'Slack mention stored');
    });

    // Handle regular messages (for channels with requiresTrigger: false)
    this.app.event('message', async ({ event }) => {
      // Skip bot's own messages, subtypes (joins, edits, etc.), and threaded replies
      const msg = event as any;
      if (msg.bot_id || msg.subtype || msg.user === this.botUserId) return;
      if (msg.thread_ts && msg.thread_ts !== msg.ts) return;

      const chatJid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const senderName = await this.resolveUserName(msg.user);
      const content = msg.text || '';

      this.opts.onChatMetadata(chatJid, timestamp, await this.resolveChannelName(msg.channel));

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid }, 'Message from unregistered Slack channel');
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msg.ts,
        chat_jid: chatJid,
        sender: msg.user || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, sender: senderName }, 'Slack message stored');
    });

    await this.app.start();
    logger.info('Slack bot connected (Socket Mode)');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.app) {
      logger.warn('Slack app not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^slack:/, '');

      // Slack message limit is ~40k but split at 4000 for readability
      const MAX_LENGTH = 4000;
      if (text.length <= MAX_LENGTH) {
        await this.app.client.chat.postMessage({
          token: this.botToken,
          channel: channelId,
          text,
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.app.client.chat.postMessage({
            token: this.botToken,
            channel: channelId,
            text: text.slice(i, i + MAX_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
    }
  }

  isConnected(): boolean {
    return this.app !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      logger.info('Slack bot stopped');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Slack doesn't have a persistent typing indicator API for bots
  }

  // --- Helpers ---

  private userNameCache = new Map<string, string>();

  private async resolveUserName(userId: string): Promise<string> {
    if (!userId) return 'Unknown';
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app!.client.users.info({
        token: this.botToken,
        user: userId,
      });
      const name =
        result.user?.profile?.display_name ||
        result.user?.real_name ||
        result.user?.name ||
        userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  private channelNameCache = new Map<string, string>();

  private async resolveChannelName(channelId: string): Promise<string> {
    const cached = this.channelNameCache.get(channelId);
    if (cached) return cached;

    try {
      const result = await this.app!.client.conversations.info({
        token: this.botToken,
        channel: channelId,
      });
      const name = (result.channel as any)?.name || channelId;
      this.channelNameCache.set(channelId, name);
      return name;
    } catch {
      return channelId;
    }
  }
}
