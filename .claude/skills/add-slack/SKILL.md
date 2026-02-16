---
name: add-slack
description: Add Slack as a channel. Can run alongside WhatsApp/Telegram or as the only channel. Uses Socket Mode (no public URL needed). Triggers on "add slack", "slack integration", "slack channel", "setup slack".
---

# Add Slack Channel

This skill adds Slack support to NanoClaw. Users can choose to:

1. **Add alongside existing channels** - Slack + WhatsApp/Telegram
2. **Use as only channel** - Slack only (set both `TELEGRAM_ONLY` and disable WhatsApp)

## Prerequisites

### 1. Install Slack Bolt

```bash
npm install @slack/bolt
```

Bolt is the official Slack framework for building apps with Socket Mode support.

### 2. Create Slack App

Tell the user:

> I need you to create a Slack app:
>
> 1. Go to https://api.slack.com/apps
> 2. Click **Create New App** > **From scratch**
> 3. Name it something friendly (e.g., "Andy") and select your workspace
> 4. Click **Create App**

Wait for user confirmation.

### 3. Enable Socket Mode

Tell the user:

> Now enable Socket Mode (this lets the bot connect without a public URL):
>
> 1. In your app settings, go to **Socket Mode** in the left sidebar
> 2. Toggle **Enable Socket Mode** to ON
> 3. You'll be prompted to create an App-Level Token:
>    - Name it "socket" (or anything)
>    - Add the scope `connections:write`
>    - Click **Generate**
> 4. Copy the **App-Level Token** (starts with `xapp-`)

Wait for user to provide the app-level token.

### 4. Configure Bot Permissions

Tell the user:

> Now set up bot permissions:
>
> 1. Go to **OAuth & Permissions** in the left sidebar
> 2. Under **Bot Token Scopes**, add these scopes:
>    - `app_mentions:read` - See when the bot is @mentioned
>    - `channels:history` - Read messages in public channels
>    - `channels:read` - View basic channel info
>    - `chat:write` - Send messages
>    - `groups:history` - Read messages in private channels
>    - `groups:read` - View basic private channel info
>    - `im:history` - Read DMs
>    - `im:read` - View basic DM info
>    - `im:write` - Open DMs
>    - `users:read` - View user display names
> 3. Click **Install to Workspace** at the top (or **Reinstall** if already installed)
> 4. Click **Allow**
> 5. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

Wait for user to provide the bot token.

### 5. Enable Events

Tell the user:

> Now enable event subscriptions:
>
> 1. Go to **Event Subscriptions** in the left sidebar
> 2. Toggle **Enable Events** to ON
> 3. Under **Subscribe to bot events**, add:
>    - `app_mention` - When the bot is @mentioned
>    - `message.channels` - Messages in public channels
>    - `message.groups` - Messages in private channels
>    - `message.im` - Direct messages
> 4. Click **Save Changes**

### 6. Invite Bot to Channel

Tell the user:

> Finally, invite your bot to the channel(s) you want to use:
>
> 1. Go to the Slack channel
> 2. Type `/invite @YourBotName`
> 3. The bot will now be able to see messages in that channel
>
> To get a channel's ID for registration:
> - Right-click the channel name > **View channel details**
> - The Channel ID is at the bottom of the popup (e.g., `C1234567890`)

## Questions to Ask

Before making changes, ask:

1. **Mode**: Add alongside existing channels, or use as the only channel?

2. **Chat behavior**: Should registered channels respond to all messages or only when @mentioned?
   - Main channel: Responds to all (set `requiresTrigger: false`)
   - Other channels: Default requires @mention (`requiresTrigger: true`)

## Architecture

NanoClaw uses a **Channel abstraction** (`Channel` interface in `src/types.ts`). Each messaging platform implements this interface. Key files:

| File | Purpose |
|------|---------|
| `src/types.ts` | `Channel` interface definition |
| `src/channels/whatsapp.ts` | `WhatsAppChannel` class (reference) |
| `src/channels/telegram.ts` | `TelegramChannel` class (reference) |
| `src/router.ts` | `findChannel()`, `routeOutbound()`, `formatOutbound()` |
| `src/index.ts` | Orchestrator: creates channels, wires callbacks, starts subsystems |

The Slack channel follows the same pattern as Telegram:
- Implements `Channel` interface (`connect`, `sendMessage`, `ownsJid`, `disconnect`, `setTyping`)
- Delivers inbound messages via `onMessage` / `onChatMetadata` callbacks
- Uses JID prefix `slack:` (e.g., `slack:C1234567890`)
- The existing message loop in `src/index.ts` picks up stored messages automatically

## Implementation

### Step 1: Update Configuration

Read `src/config.ts` and add Slack config exports. First update the `readEnvFile` call to include the new keys, then add the exports:

```typescript
// Add to readEnvFile keys array:
'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'

// Add exports:
export const SLACK_BOT_TOKEN =
  process.env.SLACK_BOT_TOKEN || envConfig.SLACK_BOT_TOKEN || '';
export const SLACK_APP_TOKEN =
  process.env.SLACK_APP_TOKEN || envConfig.SLACK_APP_TOKEN || '';
```

### Step 2: Create Slack Channel

Create `src/channels/slack.ts` implementing the `Channel` interface. Use `src/channels/telegram.ts` as the closest reference.

```typescript
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
    this.app.event('app_mention', async ({ event, say }) => {
      const chatJid = `slack:${event.channel}`;
      const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();
      const senderName = await this.resolveUserName(event.user);

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
        sender: event.user,
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
      if (msg.thread_ts && msg.thread_ts !== msg.ts) return; // skip thread replies

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
    console.log('\n  Slack bot connected via Socket Mode\n');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.app) {
      logger.warn('Slack app not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^slack:/, '');

      // Slack has a 4000 character limit per message — split if needed
      // (actual limit is ~40k but best practice is 4000 for readability)
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
```

Key differences from Telegram:
- Uses `@slack/bolt` with Socket Mode (no public URL needed)
- JID prefix: `slack:` (e.g., `slack:C1234567890`)
- Handles both `app_mention` events (always trigger) and `message` events (for `requiresTrigger: false` channels)
- Resolves user display names via Slack API (cached)
- Skips bot's own messages, subtypes, and threaded replies
- No typing indicator (Slack doesn't support it for bots via API)

### Step 3: Update Main Application

Modify `src/index.ts` to support the Slack channel.

1. **Add imports** at the top:

```typescript
import { SlackChannel } from './channels/slack.js';
import { SLACK_BOT_TOKEN, SLACK_APP_TOKEN } from './config.js';
```

2. **Add Slack channel creation** in `main()`, after the Telegram block:

```typescript
if (SLACK_BOT_TOKEN && SLACK_APP_TOKEN) {
  const slack = new SlackChannel(SLACK_BOT_TOKEN, SLACK_APP_TOKEN, channelOpts);
  channels.push(slack);
  await slack.connect();
}
```

3. **Update `getAvailableGroups`** filter to include Slack channels:

```typescript
.filter((c) => c.jid !== '__group_sync__' && (
  c.jid.endsWith('@g.us') ||
  c.jid.startsWith('tg:') ||
  c.jid.startsWith('slack:')
))
```

### Step 4: Update Environment

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-YOUR-BOT-TOKEN-HERE
SLACK_APP_TOKEN=xapp-YOUR-APP-TOKEN-HERE
```

**Important**: Sync to the container environment:

```bash
cp .env data/env/env
```

### Step 5: Register a Slack Channel

After starting the bot, tell the user:

> 1. Get the channel ID:
>    - Right-click the channel name in Slack > **View channel details**
>    - The Channel ID is at the bottom (e.g., `C1234567890`)
>    - For DMs: the channel ID starts with `D`
> 2. Make sure the bot is invited to the channel (`/invite @YourBotName`)
> 3. I'll register it for you

Registration uses the `registerGroup()` function in `src/index.ts`:

```typescript
// For main channel:
registerGroup("slack:C1234567890", {
  name: "My Slack Channel",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});

// For additional channels:
registerGroup("slack:C9876543210", {
  name: "Project Channel",
  folder: "slack-project",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

### Step 6: Build and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 7: Test

Tell the user:

> Send a message in your registered Slack channel:
> - For main channel: Any message works
> - For other channels: @mention the bot
>
> Check logs: `tail -f logs/nanoclaw.log`

## Features

### Chat ID Formats

- **WhatsApp**: `120363336345536173@g.us` (groups) or `1234567890@s.whatsapp.net` (DM)
- **Telegram**: `tg:123456789` (positive for private) or `tg:-1001234567890` (negative for groups)
- **Slack**: `slack:C1234567890` (channels) or `slack:D1234567890` (DMs)

### Trigger Options

The bot responds when:
1. Channel has `requiresTrigger: false` in its registration (e.g., main channel)
2. Bot is @mentioned in Slack (translated to TRIGGER_PATTERN automatically via `app_mention` event)
3. Message matches TRIGGER_PATTERN directly (e.g., starts with @Andy)

Slack @mentions in `app_mention` events are automatically translated: the bot @mention is stripped from the text and the trigger prefix is prepended. This ensures @mentioning the bot always triggers a response.

### Message Handling

- Bot's own messages are skipped (via `bot_id` and `user` checks)
- Message subtypes (joins, leaves, edits, etc.) are skipped
- Threaded replies are skipped (only top-level messages are processed)
- User display names are resolved and cached from the Slack API
- Messages longer than 4000 characters are automatically split

## Troubleshooting

### Bot not responding

Check:
1. `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set in `.env` AND synced to `data/env/env`
2. Channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'slack:%'"`
3. Bot is invited to the channel (`/invite @BotName`)
4. For non-main channels: message includes @mention
5. Service is running: `launchctl list | grep nanoclaw`

### Bot can't see messages

- Verify **Event Subscriptions** are enabled with the right events
- Verify **Socket Mode** is enabled
- Check that bot has `channels:history` and `groups:history` scopes
- Ensure bot is a member of the channel

### "not_in_channel" error

The bot needs to be explicitly invited to channels:
```
/invite @BotName
```

### Getting channel ID

Right-click channel name > **View channel details** > Channel ID is at the bottom.

For DMs, use the Slack API:
```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.list?types=im" | jq '.channels[] | {id, user}'
```

### Service conflicts

If running `npm run dev` while launchd service is active:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Removal

To remove Slack integration:

1. Delete `src/channels/slack.ts`
2. Remove `SlackChannel` import and creation from `src/index.ts`
3. Revert `getAvailableGroups()` filter to remove `slack:` prefix
4. Remove Slack config (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`) from `src/config.ts`
5. Remove Slack registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'slack:%'"`
6. Uninstall: `npm uninstall @slack/bolt`
7. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
