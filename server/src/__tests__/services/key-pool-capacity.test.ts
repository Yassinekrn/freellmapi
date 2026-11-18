import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import {
  canMakeRequest,
  msSincePacificMidnight,
  recordRequest,
  resetLeases,
} from '../../services/ratelimit.js';
import { routingExhaustionBody } from '../../lib/fallback-loop.js';

vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'test-provider-key') };
});

const HOUR = 60 * 60 * 1000;
const LIMITS_RPD_2 = { rpm: null, rpd: 2, tpm: null, tpd: null };

function seedUsage(platform: string, modelId: string, keyId: number, atMs: number) {
  getDb().prepare(`
    INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
    VALUES (?, ?, ?, 'request', 0, ?)
  `).run(platform, modelId, keyId, atMs);
}

/** One model on `platform` with `keyCount` healthy keys, alone in the chain. */
function seedPool(platform: string, modelId: string, keyCount: number, rpd: number): { modelDbId: number; keyIds: number[] } {
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM models').run();
  db.prepare('DELETE FROM api_keys').run();
  const modelDbId = Number(db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpd_limit)
    VALUES (?, ?, ?, 1, 1, 1, ?)
  `).run(platform, modelId, modelId, rpd).lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(modelDbId);
  const keyIds: number[] = [];
  for (let i = 0; i < keyCount; i++) {
    keyIds.push(Number(db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, 'enc', 'iv', 'tag', 'healthy', 1)
    `).run(platform, `${platform}-key-${i + 1}`).lastInsertRowid));
  }
  return { modelDbId, keyIds };
}

describe('Google per-model daily quota follows the Pacific-midnight reset', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetLeases();
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it('frees a google key whose daily requests were all made before Pacific midnight', () => {
    // 02:00 Pacific today; the two requests happened at 23:00 and 23:30 yesterday.
    const base = Date.UTC(2026, 10, 18, 12);
    const pacificMidnight = base - msSincePacificMidnight(base);
    const now = pacificMidnight + 2 * HOUR;
    vi.setSystemTime(now);
    seedUsage('google', 'gemini-test', 7, pacificMidnight - HOUR);
    seedUsage('google', 'gemini-test', 7, pacificMidnight - HOUR / 2);

    // A sliding 24h window would still count both and keep the key benched.
    expect(canMakeRequest('google', 'gemini-test', 7, LIMITS_RPD_2)).toBe(true);
  });

  it('keeps a google key benched when its daily requests were made since Pacific midnight', () => {
    const base = Date.UTC(2026, 10, 18, 12);
    const pacificMidnight = base - msSincePacificMidnight(base);
    vi.setSystemTime(pacificMidnight + 2 * HOUR);
    seedUsage('google', 'gemini-test', 7, pacificMidnight + HOUR);
    seedUsage('google', 'gemini-test', 7, pacificMidnight + HOUR + 1000);

    expect(canMakeRequest('google', 'gemini-test', 7, LIMITS_RPD_2)).toBe(false);
  });

  it('keeps the sliding 24h window for platforms without a known reset convention', () => {
    const now = Date.UTC(2026, 10, 18, 12);
    vi.setSystemTime(now);
    seedUsage('groq', 'llama-test', 7, now - 20 * HOUR);
    seedUsage('groq', 'llama-test', 7, now - 19 * HOUR);

    expect(canMakeRequest('groq', 'llama-test', 7, LIMITS_RPD_2)).toBe(false);
  });
});

describe('key pool capacity', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetLeases();
    setRoutingStrategy('priority');
  });

  it('serves keys x rpd requests for one model by rotating across every key', () => {
    const { keyIds } = seedPool('groq', 'pool-model', 3, 2);
    const served: number[] = [];
    for (let i = 0; i < 6; i++) {
      const route = routeRequest(100);
      served.push(route.keyId);
      recordRequest('groq', 'pool-model', route.keyId);
      route.release?.();
    }
    for (const id of keyIds) expect(served.filter(k => k === id)).toHaveLength(2);
    expect(() => routeRequest(100)).toThrow(/All models exhausted/);
  });

  it('gives a pool exhausted by its own daily ledger a retry time at the next Pacific midnight (google)', () => {
    seedPool('google', 'gemini-test', 2, 1);
    for (let i = 0; i < 2; i++) {
      const route = routeRequest(100);
      recordRequest('google', 'gemini-test', route.keyId);
      route.release?.();
    }

    let thrown: unknown;
    try { routeRequest(100); } catch (err) { thrown = err; }
    const now = Date.now();
    const expectedReset = now - msSincePacificMidnight(now) + 24 * HOUR;
    expect((thrown as { retryAtMs?: number }).retryAtMs).toBe(expectedReset);
    expect((thrown as Error).message).toMatch(/Soonest reset ~\d+[smh]/);

    const body = routingExhaustionBody(thrown);
    expect(body.status).toBe(429);
    expect(body.retryAtMs).toBe(expectedReset);
  });

  it('reports when the oldest request leaves the sliding window for a non-google pool', () => {
    seedPool('groq', 'pool-model', 1, 1);
    const route = routeRequest(100);
    const before = Date.now();
    recordRequest('groq', 'pool-model', route.keyId);
    route.release?.();

    let thrown: unknown;
    try { routeRequest(100); } catch (err) { thrown = err; }
    const retryAtMs = (thrown as { retryAtMs?: number }).retryAtMs!;
    expect(retryAtMs).toBeGreaterThanOrEqual(before + 24 * HOUR);
    expect(retryAtMs).toBeLessThanOrEqual(Date.now() + 24 * HOUR);
  });
});
