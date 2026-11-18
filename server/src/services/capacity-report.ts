import { getDb } from '../db/index.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import {
  canMakeRequest,
  canUseProvider,
  canUseProviderMinute,
  canUseTokens,
  cooldownExpiresAtMs,
  dailyWindowMs,
  windowsReopenAtMs,
} from './ratelimit.js';

// Per-model, per-key view of the key pool for consumers that need to know WHY
// a model is short on capacity: how many keys can serve it right now, what each
// key has spent in the current windows, which ones are cooling down, and the
// last upstream error each one returned. Key VALUES never appear: a key is named
// by its id and the operator's label only.

const LAST_ERROR_LOOKBACK = '-24 hours';

export interface CapacityKeyRow {
  key_id: number;
  label: string | null;
  status: string;
  ready: boolean;
  requests_last_minute: number;
  requests_today: number;
  cooldown_until: string | null;
  cooldown_source: string | null;
  blocked_until: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

export interface CapacityModelRow {
  platform: string;
  model_id: string;
  display_name: string;
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null };
  daily_reset: 'pacific-midnight' | 'sliding-24h';
  keys_total: number;
  keys_ready: number;
  requests_today: number;
  daily_capacity: number | null;
  retry_at: string | null;
  keys: CapacityKeyRow[];
}

export interface CapacityReportFilter {
  model?: string;
  platform?: string;
}

type ModelRow = {
  id: number; platform: string; model_id: string; display_name: string; key_id: number | null;
  rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null;
};
type KeyRow = { id: number; platform: string; label: string | null; status: string; model_scope_json: string | null; base_url: string | null };

function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

function dailyWindowStartMs(platform: string, now: number): number {
  return now - dailyWindowMs(platform, now);
}

export function buildCapacityReport(filter: CapacityReportFilter = {}, now = Date.now()): CapacityModelRow[] {
  const db = getDb();
  const keys = db.prepare(`
    SELECT id, platform, label, status, model_scope_json, base_url
      FROM api_keys WHERE enabled = 1
  `).all() as KeyRow[];
  const keysByPlatform = new Map<string, KeyRow[]>();
  for (const k of keys) {
    const list = keysByPlatform.get(k.platform);
    if (list) list.push(k);
    else keysByPlatform.set(k.platform, [k]);
  }

  const models = (db.prepare(`
    SELECT id, platform, model_id, display_name, key_id, rpm_limit, rpd_limit, tpm_limit, tpd_limit
      FROM models WHERE enabled = 1
     ORDER BY platform, model_id
  `).all() as ModelRow[])
    .filter(m => keysByPlatform.has(m.platform))
    .filter(m => !filter.model || m.model_id === filter.model)
    .filter(m => !filter.platform || m.platform === filter.platform);
  if (models.length === 0) return [];

  // Usage per (platform, model, key) in one scan per window instead of one
  // count per key per model.
  const usage = new Map<string, { minute: number; day: number }>();
  const usageRows = db.prepare(`
    SELECT platform, model_id, key_id, created_at_ms FROM rate_limit_usage
     WHERE kind = 'request' AND created_at_ms > ?
  `).all(now - 24 * 60 * 60 * 1000) as { platform: string; model_id: string; key_id: number; created_at_ms: number }[];
  const dayStart = new Map<string, number>();
  for (const r of usageRows) {
    const start = dayStart.get(r.platform) ?? dailyWindowStartMs(r.platform, now);
    dayStart.set(r.platform, start);
    const id = `${r.platform}\u0000${r.model_id}\u0000${r.key_id}`;
    const u = usage.get(id) ?? { minute: 0, day: 0 };
    if (r.created_at_ms > start) u.day += 1;
    if (r.created_at_ms > now - 60_000) u.minute += 1;
    usage.set(id, u);
  }

  const lastErrors = new Map<string, { error: string; at: string }>();
  const errorRows = db.prepare(`
    SELECT r.platform, r.model_id, r.key_id, r.error, r.created_at
      FROM requests r
      JOIN (
        SELECT platform, model_id, key_id, MAX(id) AS id
          FROM requests
         WHERE status != 'success' AND error IS NOT NULL AND key_id IS NOT NULL
           AND created_at > datetime('now', ?)
         GROUP BY platform, model_id, key_id
      ) latest ON latest.id = r.id
  `).all(LAST_ERROR_LOOKBACK) as { platform: string; model_id: string; key_id: number; error: string; created_at: string }[];
  for (const e of errorRows) {
    lastErrors.set(`${e.platform}\u0000${e.model_id}\u0000${e.key_id}`, {
      error: sanitizeProviderErrorMessage(e.error),
      at: `${e.created_at.replace(' ', 'T')}Z`,
    });
  }

  return models.map(m => {
    const limits = { rpm: m.rpm_limit, rpd: m.rpd_limit, tpm: m.tpm_limit, tpd: m.tpd_limit };
    const customBaseUrl = m.platform === 'custom' && m.key_id != null
      ? keys.find(k => k.id === m.key_id)?.base_url ?? null
      : null;
    const candidates = (keysByPlatform.get(m.platform) ?? [])
      .filter(k => scopeAllows(parseModelScope(k.model_scope_json), m.model_id))
      .filter(k => m.platform !== 'custom' || m.key_id == null || k.id === m.key_id || (customBaseUrl != null && k.base_url === customBaseUrl));

    const keyRows: CapacityKeyRow[] = candidates.map(k => {
      const id = `${m.platform}\u0000${m.model_id}\u0000${k.id}`;
      const u = usage.get(id) ?? { minute: 0, day: 0 };
      const cooldownMs = cooldownExpiresAtMs(m.platform, m.model_id, k.id);
      const healthy = k.status === 'healthy' || k.status === 'unknown';
      const windowsOpen = canMakeRequest(m.platform, m.model_id, k.id, limits)
        && canUseTokens(m.platform, m.model_id, k.id, 1, limits);
      const ready = healthy && cooldownMs == null && windowsOpen
        && canUseProvider(m.platform, k.id) && canUseProviderMinute(m.platform, k.id);
      const windowReopen = windowsOpen ? null : windowsReopenAtMs(m.platform, m.model_id, k.id, limits, 1, now);
      const blockedUntil = Math.max(cooldownMs ?? 0, windowReopen ?? 0) || null;
      const cooldownSource = cooldownMs == null ? null : (db.prepare(`
        SELECT source FROM rate_limit_cooldowns WHERE platform = ? AND model_id = ? AND key_id = ?
      `).get(m.platform, m.model_id, k.id) as { source: string | null } | undefined)?.source ?? null;
      const lastError = lastErrors.get(id);
      return {
        key_id: k.id,
        label: k.label || null,
        status: k.status,
        ready,
        requests_last_minute: u.minute,
        requests_today: u.day,
        cooldown_until: iso(cooldownMs),
        cooldown_source: cooldownSource,
        blocked_until: iso(blockedUntil),
        last_error: lastError?.error ?? null,
        last_error_at: lastError?.at ?? null,
      };
    });

    const healthyCount = keyRows.filter(k => k.status === 'healthy' || k.status === 'unknown').length;
    const blockedTimes = keyRows.filter(k => !k.ready && k.blocked_until).map(k => Date.parse(k.blocked_until!));
    const keysReady = keyRows.filter(k => k.ready).length;
    return {
      platform: m.platform,
      model_id: m.model_id,
      display_name: m.display_name,
      limits,
      daily_reset: m.platform === 'google' ? 'pacific-midnight' : 'sliding-24h',
      keys_total: keyRows.length,
      keys_ready: keysReady,
      requests_today: keyRows.reduce((sum, k) => sum + k.requests_today, 0),
      // What the local ledger allows per day across the pool. The provider's
      // real budget can be lower, e.g. when several keys share one Google project.
      daily_capacity: m.rpd_limit == null ? null : m.rpd_limit * healthyCount,
      retry_at: keysReady > 0 || blockedTimes.length === 0 ? null : iso(Math.min(...blockedTimes)),
      keys: keyRows,
    };
  });
}
