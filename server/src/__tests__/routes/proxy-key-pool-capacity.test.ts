import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { setCooldown, resetLeases } from '../../services/ratelimit.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';
const PROVIDER_SECRET = 'gsk_capacity_test_secret_value';

async function request(app: Express, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

const auth = () => ({ Authorization: `Bearer ${getUnifiedApiKey()}` });

describe('key pool capacity on /v1/chat/completions', () => {
  let app: Express;
  let primaryModel: string;
  let siblingModel: string;
  let keyId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    const groq = getDb().prepare(`
      SELECT m.model_id FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.platform = 'groq' AND m.enabled = 1
      ORDER BY fc.priority LIMIT 2
    `).all() as { model_id: string }[];
    primaryModel = groq[0].model_id;
    siblingModel = groq[1].model_id;
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    resetLeases();
    const added = await request(app, 'POST', '/api/keys', { platform: 'groq', key: PROVIDER_SECRET, label: 'groq-a' });
    expect(added.status).toBe(201);
    keyId = (db.prepare("SELECT id FROM api_keys WHERE label = 'groq-a'").get() as { id: number }).id;

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-cap', object: 'chat.completion', created: 1, model: 'default',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  const chat = (model: string, headers: Record<string, string> = {}) =>
    request(app, 'POST', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }] }, { ...auth(), ...headers });

  it('answers a Claude family id listed by /v1/models instead of 404ing it', async () => {
    const listed = await request(app, 'GET', '/v1/models', undefined, auth());
    expect(listed.body.data.map((m: { id: string }) => m.id)).toContain('claude-sonnet-4-5');

    const res = await chat('claude-sonnet-4-5');
    expect(res.status).toBe(200);
  });

  it('returns 429 with a Retry-After when the pinned model has no key left and no fallback is named', async () => {
    setCooldown('groq', primaryModel, keyId, 10 * 60_000);
    const res = await chat(primaryModel);
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(500);
    expect(retryAfter).toBeLessThanOrEqual(600);
  });

  it('serves a pinned request from the X-Fallback-Models sibling once the pinned pool is exhausted', async () => {
    setCooldown('groq', primaryModel, keyId, 10 * 60_000);
    const res = await chat(primaryModel, { 'X-Fallback-Models': `does-not-exist, ${siblingModel}` });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe(siblingModel);
    const row = getDb().prepare('SELECT model_id FROM requests ORDER BY id DESC LIMIT 1').get() as { model_id: string };
    expect(row.model_id).toBe(siblingModel);
  });

  it('still prefers the pinned model over its fallbacks while the pinned model has a key', async () => {
    const res = await chat(primaryModel, { 'X-Fallback-Models': siblingModel });
    expect(res.status).toBe(200);
    const row = getDb().prepare('SELECT model_id FROM requests ORDER BY id DESC LIMIT 1').get() as { model_id: string };
    expect(row.model_id).toBe(primaryModel);
  });

  it('GET /v1/capacity reports per-key cooldowns by label without exposing the key value', async () => {
    setCooldown('groq', primaryModel, keyId, 10 * 60_000);
    const res = await request(app, 'GET', `/v1/capacity?model=${encodeURIComponent(primaryModel)}`, undefined, auth());
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(PROVIDER_SECRET);
    const row = res.body.models.find((m: { platform: string }) => m.platform === 'groq');
    expect(row.keys_total).toBe(1);
    expect(row.keys_ready).toBe(0);
    expect(row.keys[0]).toMatchObject({ key_id: keyId, label: 'groq-a', ready: false });
    expect(Date.parse(row.keys[0].cooldown_until)).toBeGreaterThan(Date.now());
    expect(Date.parse(row.retry_at)).toBeGreaterThan(Date.now());
  });

  it('GET /v1/capacity requires the unified API key', async () => {
    const res = await request(app, 'GET', '/v1/capacity');
    expect(res.status).toBe(401);
  });
});
