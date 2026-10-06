import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';

import { BaseProvider, type KeyValidationResult } from './base.js';

const ELEVENLABS_MODELS_URL = 'https://api.elevenlabs.io/v1/models';

/**
 * ElevenLabs — text-to-speech only. There is no chat surface, so this class
 * exists for key storage and validation; synthesis lives in services/media.ts
 * alongside the other audio adapters.
 *
 * validateKey probes GET /v1/models (cheap, spends no credits). Verdicts:
 *   200            → key is live.
 *   401 (bad key)  → invalid; feeds the consecutive-failure auto-disable.
 *   401 with status `missing_permissions` → the key authenticated but is a
 *                    restricted key that cannot read models. It may still have
 *                    text_to_speech access, so it is NOT treated as revoked.
 *   401 with `quota_exceeded` → the key is fine, the monthly credits are spent.
 *   401 with `detected_unusual_activity` → ElevenLabs disabled the free tier
 *                    for this IP (common from datacenter hosts). The key is not
 *                    at fault, so this is inconclusive rather than invalid.
 */
export class ElevenLabsProvider extends BaseProvider {
  readonly platform = 'elevenlabs' as const;
  readonly name = 'ElevenLabs';

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw new Error('ElevenLabs is a text-to-speech provider and does not support chat completions');
  }

  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw new Error('ElevenLabs is a text-to-speech provider and does not support chat completions');
  }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    // Transport errors propagate: health.ts records them without counting
    // toward auto-disable, so only a confirmed 401 can disable a key.
    const res = await this.fetchWithTimeout(ELEVENLABS_MODELS_URL, {
      method: 'GET',
      headers: { 'xi-api-key': apiKey },
    }, 30000, { timeoutBounds: 'request' });

    if (res.ok) return true;

    if (res.status === 401) {
      const status = await readErrorStatus(res.clone());
      if (status === 'missing_permissions' || status === 'quota_exceeded') return true;
      if (status === 'detected_unusual_activity') {
        throw new Error(
          'ElevenLabs disabled free-tier usage for this IP (detected_unusual_activity). ' +
          'The key itself is not treated as revoked.',
        );
      }
      return this.validationResult(res);
    }
    throw new Error(`ElevenLabs /v1/models returned HTTP ${res.status} — key validity unknown`);
  }
}

/** ElevenLabs error bodies look like `{ detail: { status, message } }`. */
async function readErrorStatus(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { detail?: { status?: unknown } };
    return typeof body?.detail?.status === 'string' ? body.detail.status : null;
  } catch {
    return null;
  }
}
