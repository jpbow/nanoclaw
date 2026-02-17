import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface TranscriptionConfig {
  provider: string;
  elevenlabs?: {
    model: string;
  };
  enabled: boolean;
  fallbackMessage: string;
}

function loadConfig(): TranscriptionConfig {
  const configPath = path.join(__dirname, '../.transcription.config.json');
  try {
    const configData = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(configData);
  } catch {
    return {
      provider: 'elevenlabs',
      enabled: false,
      fallbackMessage: '[Voice Message - transcription unavailable]',
    };
  }
}

async function transcribeWithElevenLabs(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): Promise<string | null> {
  const apiKey = readEnvFile(['ELEVENLABS_API_KEY']).ELEVENLABS_API_KEY;
  if (!apiKey) {
    logger.warn('ELEVENLABS_API_KEY not set in .env');
    return null;
  }

  const formData = new FormData();
  formData.append('model_id', config.elevenlabs?.model || 'scribe_v2');
  formData.append(
    'file',
    new Blob([audioBuffer], { type: 'audio/ogg' }),
    'voice.ogg',
  );

  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status, body: errorText },
      'ElevenLabs API error',
    );
    return null;
  }

  const result = (await response.json()) as { text: string };
  return result.text;
}

/**
 * Transcribe an audio buffer from any channel.
 * Returns the transcribed text, a fallback message, or null on error.
 */
export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
): Promise<string | null> {
  const config = loadConfig();

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  try {
    if (!audioBuffer || audioBuffer.length === 0) {
      logger.error('Empty audio buffer');
      return config.fallbackMessage;
    }

    logger.info({ bytes: audioBuffer.length }, 'Transcribing audio');

    let transcript: string | null = null;

    switch (config.provider) {
      case 'elevenlabs':
        transcript = await transcribeWithElevenLabs(audioBuffer, config);
        break;
      default:
        logger.error({ provider: config.provider }, 'Unknown transcription provider');
        return config.fallbackMessage;
    }

    if (!transcript) {
      return config.fallbackMessage;
    }

    return transcript.trim();
  } catch (err) {
    logger.error({ err }, 'Transcription error');
    return config.fallbackMessage;
  }
}

/**
 * Transcribe a WhatsApp voice message.
 * Returns the transcribed text, a fallback message, or null on error.
 */
export async function transcribeVoiceMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = loadConfig();

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: logger as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    return transcribeAudioBuffer(buffer);
  } catch (err) {
    logger.error({ err }, 'Voice download error');
    return config.fallbackMessage;
  }
}
