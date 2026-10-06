import { describe, it, expect, vi, afterEach } from 'vitest';
import { ElevenLabsProvider } from '../../providers/elevenlabs.js';
import { hasProvider } from '../../providers/index.js';
import type { KeyValidationFailure } from '../../providers/base.js';

const realFetch = globalThis.fetch;

function respond(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  ) as unknown as typeof fetch;
}

describe('ElevenLabsProvider.validateKey', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('is registered as a platform', () => {
    expect(hasProvider('elevenlabs')).toBe(true);
  });

  it('accepts a key that /v1/models answers 200 for', async () => {
    respond(200, []);
    expect(await new ElevenLabsProvider().validateKey('xi-ok')).toBe(true);
  });

  it('rejects a revoked key with the upstream reason', async () => {
    respond(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
    const result = await new ElevenLabsProvider().validateKey('xi-bad');
    expect((result as KeyValidationFailure).valid).toBe(false);
  });

  it('keeps a restricted key without models_read permission', async () => {
    respond(401, { detail: { status: 'missing_permissions', message: 'needs models_read' } });
    expect(await new ElevenLabsProvider().validateKey('xi-restricted')).toBe(true);
  });

  it('keeps a key whose monthly credits are spent', async () => {
    respond(401, { detail: { status: 'quota_exceeded', message: 'out of credits' } });
    expect(await new ElevenLabsProvider().validateKey('xi-spent')).toBe(true);
  });

  it('is inconclusive, not invalid, when the free tier is blocked for the IP', async () => {
    respond(401, { detail: { status: 'detected_unusual_activity', message: 'Unusual activity detected. Free Tier usage disabled' } });
    await expect(new ElevenLabsProvider().validateKey('xi-any')).rejects.toThrow(/detected_unusual_activity/);
  });
});
