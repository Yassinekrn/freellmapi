import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearCooldownsForKey } from '../../services/ratelimit.js';
import { ensureElevenLabsModels, runSpeech } from '../../services/media.js';

const realFetch = globalThis.fetch;

function addKey(raw: string): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const r = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('elevenlabs', 'test', ?, ?, ?, 'healthy', 1)
  `).run(encrypted, iv, authTag);
  return Number(r.lastInsertRowid);
}

function errorBody(status: string): string {
  return JSON.stringify({ detail: { status, message: 'nope' } });
}

function callKey(call: unknown[]): string {
  return (call[1] as { headers: Record<string, string> }).headers['xi-api-key'];
}

describe('ElevenLabs speech adapter', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    // Cooldowns live in module memory and key ids restart at 1 on every fresh
    // in-memory DB, so one test's benched key would otherwise bench the next's.
    [1, 2].forEach(clearCooldownsForKey);
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('seeds the TTS models only once an ElevenLabs key exists, and is idempotent', () => {
    const count = () => (getDb().prepare("SELECT COUNT(*) AS n FROM media_models WHERE platform = 'elevenlabs'").get() as { n: number }).n;
    ensureElevenLabsModels();
    expect(count()).toBe(0);
    addKey('xi-a');
    ensureElevenLabsModels();
    ensureElevenLabsModels();
    expect(count()).toBe(3);
  });

  it('returns mp3 audio and sends key, model and mapped voice to the TTS endpoint', async () => {
    addKey('xi-a');
    ensureElevenLabsModels();
    const fetchMock = vi.fn(async () => new Response(Buffer.from('MP3'), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await runSpeech('eleven_flash_v2_5', { input: 'hello', voice: 'nova' });

    expect(r.audio.toString()).toBe('MP3');
    expect(r.contentType).toBe('audio/mpeg');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL?output_format=mp3_44100_128');
    expect(callKey(fetchMock.mock.calls[0])).toBe('xi-a');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'hello', model_id: 'eleven_flash_v2_5' });
  });

  it('passes a raw voice_id through and falls back to the default voice for unknown names', async () => {
    addKey('xi-a');
    ensureElevenLabsModels();
    const fetchMock = vi.fn(async () => new Response(Buffer.from('MP3'), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await runSpeech('eleven_flash_v2_5', { input: 'x', voice: 'JBFqnCBsd6RMkjVDRZzb' });
    await runSpeech('eleven_flash_v2_5', { input: 'x', voice: 'not-a-voice' });

    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls[0]).toContain('/text-to-speech/JBFqnCBsd6RMkjVDRZzb?');
    expect(urls[1]).toContain('/text-to-speech/21m00Tcm4TlvDq8ikWAM?');
  });

  it('serves pcm as pcm_24000 and falls back to mp3 for formats the free tier lacks', async () => {
    addKey('xi-a');
    ensureElevenLabsModels();
    const fetchMock = vi.fn(async () => new Response(Buffer.from('AUDIO'), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pcm = await runSpeech('eleven_flash_v2_5', { input: 'x', format: 'pcm' });
    const opus = await runSpeech('eleven_flash_v2_5', { input: 'x', format: 'opus' });

    expect(String(fetchMock.mock.calls[0][0])).toContain('output_format=pcm_24000');
    expect(pcm.contentType).toBe('audio/L16');
    expect(String(fetchMock.mock.calls[1][0])).toContain('output_format=mp3_44100_128');
    expect(opus.contentType).toBe('audio/mpeg');
  });

  it('marks a key invalid on a plain 401 and fails over to the next key', async () => {
    const bad = addKey('xi-bad');
    addKey('xi-good');
    ensureElevenLabsModels();
    globalThis.fetch = vi.fn(async (_u: unknown, init: RequestInit) =>
      (init.headers as Record<string, string>)['xi-api-key'] === 'xi-bad'
        ? new Response(errorBody('invalid_api_key'), { status: 401 })
        : new Response(Buffer.from('OK'), { status: 200 }),
    ) as unknown as typeof fetch;

    // Random pick: enough runs that the bad key is certainly drawn at least once.
    for (let i = 0; i < 20; i++) {
      const r = await runSpeech('eleven_flash_v2_5', { input: 'x' });
      expect(r.audio.toString()).toBe('OK');
    }
    const row = getDb().prepare('SELECT status FROM api_keys WHERE id = ?').get(bad) as { status: string };
    expect(row.status).toBe('invalid');
  });

  it.each([
    ['429 rate limit', 429, 'too_many_concurrent_requests'],
    ['quota_exceeded (reported as 401)', 401, 'quota_exceeded'],
    ['unusual activity (reported as 401)', 401, 'detected_unusual_activity'],
  ])('cools the key down on %s without marking it invalid, and uses the other key', async (_label, httpStatus, code) => {
    const limited = addKey('xi-limited');
    addKey('xi-good');
    ensureElevenLabsModels();
    const fetchMock = vi.fn(async (_u: unknown, init: RequestInit) =>
      (init.headers as Record<string, string>)['xi-api-key'] === 'xi-limited'
        ? new Response(errorBody(code), { status: httpStatus })
        : new Response(Buffer.from('OK'), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    for (let i = 0; i < 20; i++) {
      expect((await runSpeech('eleven_flash_v2_5', { input: 'x' })).audio.toString()).toBe('OK');
    }

    const row = getDb().prepare('SELECT status FROM api_keys WHERE id = ?').get(limited) as { status: string };
    expect(row.status).toBe('healthy');
    // Cooled after its first failure, so it is hit at most once across all runs.
    expect(fetchMock.mock.calls.filter(c => callKey(c) === 'xi-limited').length).toBeLessThanOrEqual(1);
  });

  it('reports a failure when every ElevenLabs key is exhausted', async () => {
    addKey('xi-a');
    addKey('xi-b');
    ensureElevenLabsModels();
    const fetchMock = vi.fn(async () => new Response(errorBody('quota_exceeded'), { status: 401 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(runSpeech('eleven_flash_v2_5', { input: 'x' })).rejects.toThrow(/All audio providers failed/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
