---
name: add-elevenlabs-transcription
description: Add voice message transcription to NanoClaw using ElevenLabs Scribe API. Automatically transcribes WhatsApp voice notes so the agent can read and respond to them.
---

# Add Voice Message Transcription (ElevenLabs)

This skill adds automatic voice message transcription using ElevenLabs' Scribe v2 API. When users send voice notes in WhatsApp, they'll be transcribed and the agent can read and respond to the content.

**No new npm dependencies required** — uses native `fetch()` (Node 22) with `FormData` to call the ElevenLabs REST API directly.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text. This integrates with Claude's built-in question/answer system for a better experience.

## Prerequisites

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool** to present this:

> You'll need an ElevenLabs API key for voice transcription.
>
> Get one at: https://elevenlabs.io/app/settings/api-keys
>
> Cost: Scribe v2 is free for the first 10,000 characters/month, then ~$0.30 per hour of audio.
>
> Once you have your API key, we'll configure it securely.

Wait for user to confirm they have an API key before continuing.

---

## Implementation

### Step 1: Configure API Key

Read the existing `.env` file and add the ElevenLabs API key:

```
ELEVENLABS_API_KEY=<user's key>
```

**Use the AskUserQuestion tool** to ask the user for their API key:

> Please paste your ElevenLabs API key so I can add it to `.env`:

Verify `.env` is already in `.gitignore` (it should be). If not, add it.

### Step 2: Create Transcription Configuration

Create a configuration file for transcription settings.

Write to `.transcription.config.json`:

```json
{
  "provider": "elevenlabs",
  "elevenlabs": {
    "model": "scribe_v2"
  },
  "enabled": true,
  "fallbackMessage": "[Voice Message - transcription unavailable]"
}
```

Add this file to `.gitignore` to prevent committing it:

```bash
echo ".transcription.config.json" >> .gitignore
```

### Step 3: Create Transcription Module

Create `src/transcription.ts`:

```typescript
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration interface
interface TranscriptionConfig {
  provider: string;
  elevenlabs?: {
    model: string;
  };
  enabled: boolean;
  fallbackMessage: string;
}

// Load configuration
function loadConfig(): TranscriptionConfig {
  const configPath = path.join(__dirname, '../.transcription.config.json');
  try {
    const configData = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(configData);
  } catch (err) {
    console.error('Failed to load transcription config:', err);
    return {
      provider: 'elevenlabs',
      enabled: false,
      fallbackMessage: '[Voice Message - transcription unavailable]'
    };
  }
}

// Transcribe audio using ElevenLabs Scribe API
async function transcribeWithElevenLabs(audioBuffer: Buffer, config: TranscriptionConfig): Promise<string | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.warn('ELEVENLABS_API_KEY not set in environment');
    return null;
  }

  try {
    const formData = new FormData();
    formData.append('model_id', config.elevenlabs?.model || 'scribe_v2');
    formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');

    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`ElevenLabs API error (${response.status}):`, errorText);
      return null;
    }

    const result = await response.json() as { text: string };
    return result.text;
  } catch (err) {
    console.error('ElevenLabs transcription failed:', err);
    return null;
  }
}

// Main transcription function
export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket
): Promise<string | null> {
  const config = loadConfig();

  // Check if transcription is enabled
  if (!config.enabled) {
    console.log('Transcription disabled in config');
    return config.fallbackMessage;
  }

  try {
    // Download the audio message
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage
      }
    ) as Buffer;

    if (!buffer || buffer.length === 0) {
      console.error('Failed to download audio message');
      return config.fallbackMessage;
    }

    console.log(`Downloaded audio message: ${buffer.length} bytes`);

    // Transcribe based on provider
    let transcript: string | null = null;

    switch (config.provider) {
      case 'elevenlabs':
        transcript = await transcribeWithElevenLabs(buffer, config);
        break;
      default:
        console.error(`Unknown transcription provider: ${config.provider}`);
        return config.fallbackMessage;
    }

    if (!transcript) {
      return config.fallbackMessage;
    }

    return transcript.trim();
  } catch (err) {
    console.error('Transcription error:', err);
    return config.fallbackMessage;
  }
}

// Helper to check if a message is a voice note
export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
```

### Step 4: Update Database to Handle Transcribed Content

Read `src/db.ts` and find the `storeMessage` function. Update its signature and implementation to accept transcribed content:

Change the function signature from:
```typescript
export function storeMessage(msg: proto.IWebMessageInfo, chatJid: string, isFromMe: boolean, pushName?: string): void
```

To:
```typescript
export function storeMessage(msg: proto.IWebMessageInfo, chatJid: string, isFromMe: boolean, pushName?: string, transcribedContent?: string): void
```

Update the content extraction to use transcribed content if provided:

```typescript
const content = transcribedContent ||
  msg.message?.conversation ||
  msg.message?.extendedTextMessage?.text ||
  msg.message?.imageMessage?.caption ||
  msg.message?.videoMessage?.caption ||
  (msg.message?.audioMessage?.ptt ? '[Voice Message]' : '') ||
  '';
```

### Step 5: Integrate Transcription into Message Handler

**Note:** Voice messages are transcribed for all messages in registered groups, regardless of the trigger word. This is because:
1. Voice notes can't easily include a trigger word
2. Users expect voice notes to work the same as text messages
3. The transcribed content is stored in the database for context, even if it doesn't trigger the agent

Read `src/index.ts` and find the `sock.ev.on('messages.upsert', ...)` event handler.

Change the callback from synchronous to async:

```typescript
sock.ev.on('messages.upsert', async ({ messages }) => {
```

Inside the loop where messages are stored, add voice message detection and transcription:

```typescript
// Only store full message content for registered groups
if (registeredGroups[chatJid]) {
  // Check if this is a voice message
  if (msg.message.audioMessage?.ptt) {
    try {
      // Import transcription module
      const { transcribeAudioMessage } = await import('./transcription.js');
      const transcript = await transcribeAudioMessage(msg, sock);

      if (transcript) {
        // Store with transcribed content
        storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined, `[Voice: ${transcript}]`);
        logger.info({ chatJid, length: transcript.length }, 'Transcribed voice message');
      } else {
        // Store with fallback message
        storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined, '[Voice Message - transcription unavailable]');
      }
    } catch (err) {
      logger.error({ err }, 'Voice transcription error');
      storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined, '[Voice Message - transcription failed]');
    }
  } else {
    // Regular message, store normally
    storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined);
  }
}
```

### Step 6: Fix Orphan Container Cleanup (CRITICAL)

**This step is essential.** When the NanoClaw service restarts (e.g., `launchctl kickstart -k`), the running container is detached but NOT killed. The new service instance spawns a fresh container, but the orphan keeps running and shares the same IPC mount directory. Both containers race to read IPC input files, causing the new container to randomly miss messages — making it appear like the agent doesn't respond.

The existing cleanup code in `ensureContainerSystemRunning()` in `src/index.ts` uses `container ls --format {{.Names}}` which **silently fails** on Apple Container (only `json` and `table` are valid format options). The catch block swallows the error, so orphans are never cleaned up.

Find the orphan cleanup block in `ensureContainerSystemRunning()` (the section starting with `// Kill and clean up orphaned NanoClaw containers from previous runs`) and replace it with:

```typescript
  // Kill and clean up orphaned NanoClaw containers from previous runs
  try {
    const listJson = execSync('container ls -a --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers = JSON.parse(listJson) as Array<{ configuration: { id: string }; status: string }>;
    const nanoclawContainers = containers.filter(
      (c) => c.configuration.id.startsWith('nanoclaw-'),
    );
    const running = nanoclawContainers
      .filter((c) => c.status === 'running')
      .map((c) => c.configuration.id);
    if (running.length > 0) {
      execSync(`container stop ${running.join(' ')}`, { stdio: 'pipe' });
      logger.info({ count: running.length }, 'Stopped orphaned containers');
    }
    const allNames = nanoclawContainers.map((c) => c.configuration.id);
    if (allNames.length > 0) {
      execSync(`container rm ${allNames.join(' ')}`, { stdio: 'pipe' });
      logger.info({ count: allNames.length }, 'Cleaned up stopped containers');
    }
  } catch {
    // No containers or cleanup not supported
  }
```

### Step 7: Build and Restart

```bash
npm run build
```

Before restarting the service, kill any orphaned containers manually to ensure a clean slate:

```bash
container ls -a --format json | python3 -c "
import sys, json
data = json.load(sys.stdin)
nc = [c['configuration']['id'] for c in data if c['configuration']['id'].startswith('nanoclaw-')]
if nc: print(' '.join(nc))
" | xargs -r container stop 2>/dev/null
container ls -a --format json | python3 -c "
import sys, json
data = json.load(sys.stdin)
nc = [c['configuration']['id'] for c in data if c['configuration']['id'].startswith('nanoclaw-')]
if nc: print(' '.join(nc))
" | xargs -r container rm 2>/dev/null
echo "Orphaned containers cleaned"
```

Now restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Verify it started with exactly one (or zero, before first message) nanoclaw container:

```bash
sleep 3 && launchctl list | grep nanoclaw
container ls -a --format json | python3 -c "
import sys, json
data = json.load(sys.stdin)
nc = [c for c in data if c['configuration']['id'].startswith('nanoclaw-')]
print(f'{len(nc)} nanoclaw container(s)')
for c in nc: print(f'  {c[\"configuration\"][\"id\"]} - {c[\"status\"]}')
"
```

### Step 8: Test Voice Transcription

Tell the user:

> Voice transcription is ready! Test it by:
>
> 1. Open WhatsApp on your phone
> 2. Go to a registered group chat
> 3. Send a voice note using the microphone button
> 4. The agent should receive the transcribed text and respond
>
> In the database and agent context, voice messages appear as:
> `[Voice: <transcribed text here>]`

Watch for transcription in the logs:

```bash
tail -f logs/nanoclaw.log | grep -i "voice\|transcri"
```

---

## Configuration Options

### Enable/Disable Transcription

To temporarily disable without removing code, edit `.transcription.config.json`:

```json
{
  "enabled": false
}
```

### Change Fallback Message

Customize what's stored when transcription fails:

```json
{
  "fallbackMessage": "[Voice note - transcription unavailable]"
}
```

---

## Troubleshooting

### Agent doesn't respond to voice messages (or any messages after a voice note)

**Most likely cause: orphaned containers.** When the service restarts, the previous container keeps running and races to consume IPC messages. Check:

```bash
container ls -a --format json | python3 -c "
import sys, json
data = json.load(sys.stdin)
nc = [c for c in data if c['configuration']['id'].startswith('nanoclaw-')]
print(f'{len(nc)} nanoclaw container(s):')
for c in nc: print(f'  {c[\"configuration\"][\"id\"]} - {c[\"status\"]}')
"
```

If you see more than one running container, kill the orphans:

```bash
# Stop all nanoclaw containers, then restart the service
container ls -a --format json | python3 -c "
import sys, json
data = json.load(sys.stdin)
running = [c['configuration']['id'] for c in data if c['configuration']['id'].startswith('nanoclaw-') and c['status'] == 'running']
if running: print(' '.join(running))
" | xargs -r container stop 2>/dev/null
container ls -a --format json | python3 -c "
import sys, json
data = json.load(sys.stdin)
nc = [c['configuration']['id'] for c in data if c['configuration']['id'].startswith('nanoclaw-')]
if nc: print(' '.join(nc))
" | xargs -r container rm 2>/dev/null
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Root cause:** The `ensureContainerSystemRunning()` function previously used `container ls --format {{.Names}}` which silently fails on Apple Container (only `json` and `table` formats are supported). Step 6 of this skill fixes this. If you haven't applied Step 6, the orphan problem will recur on every restart.

### "Transcription unavailable" or "Transcription failed"

Check logs for specific errors:
```bash
tail -100 logs/nanoclaw.log | grep -i transcription
```

Common causes:
- `ELEVENLABS_API_KEY` not set in `.env`
- API key invalid or expired
- No API credits remaining
- Network connectivity issues

### Voice messages not being detected

- Ensure you're sending actual voice notes (microphone button), not audio file attachments
- Check that `audioMessage.ptt` is `true` in the message object

### ES Module errors (`__dirname is not defined`)

The fix is already included in the implementation above using:
```typescript
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

---

## Security Notes

- The API key is stored in `.env` which should NOT be committed to version control
- Audio files are sent to ElevenLabs for transcription - review their data usage policy
- No audio files are stored locally after transcription
- Transcripts are stored in the SQLite database like regular text messages

---

## Cost Management

Monitor usage in your ElevenLabs dashboard: https://elevenlabs.io/app/usage

Tips to control costs:
- Scribe v2 includes a generous free tier (10,000 chars/month)
- Disable transcription during development/testing with `"enabled": false`
- Typical usage: 100 voice notes/month (~3 minutes average) is well within free tier

---

## Removing Voice Transcription

To remove the feature:

1. Delete `src/transcription.ts`

2. Revert changes in `src/index.ts`:
   - Remove the voice message handling block
   - Change callback back to synchronous if desired

3. Revert changes in `src/db.ts`:
   - Remove the `transcribedContent` parameter from `storeMessage`

4. Delete `.transcription.config.json`

5. Remove `ELEVENLABS_API_KEY` from `.env`

6. Rebuild:
   ```bash
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
