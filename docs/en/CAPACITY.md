**English**

# Key pools and capacity

> **Source:** `server/src/services/router.ts` (`selectKeyForModel`, `appendFallbackCandidates`), `server/src/services/ratelimit.ts` (`canMakeRequest`, `dailyWindowMs`, cooldowns), `server/src/lib/fallback-loop.ts` (`cooldownDecisionForError`, `routingExhaustionBody`), `server/src/services/capacity-report.ts`, `server/src/routes/status.ts`

This page explains how many requests a set of provider keys can actually serve, why adding keys sometimes does not help, and which knobs change that.

## How a request picks a key

1. The request's `model` decides the **candidate models**:
   - `auto` (or no `model`) walks the active fallback chain; `auto:<chain>` walks a named chain.
   - A concrete id (`gemini-2.5-flash`) is a **strict pin** (#335). With model unification on, it covers every provider row of that logical model, and it never falls through to a different model unless you name fallbacks (see below).
2. For each candidate model, the router walks **every enabled key of that platform** whose status is `healthy` or `unknown` and whose model scope allows the model. Keys are tried in per-key score order when there is history, otherwise round-robin.
3. A key is skipped, for this model only, when any gate is closed:
   - a **cooldown** on `(platform, model, key)`;
   - the model's own `rpm` / `rpd` / `tpm` / `tpd` limits, counted **per key** in the local ledger;
   - a provider-wide cap for that key (`PROVIDER_DAILY_REQUEST_CAP_<PLATFORM>`, `PROVIDER_MINUTE_REQUEST_CAP_<PLATFORM>`, `PROVIDER_DAILY_TOKEN_CAP_<PLATFORM>`), the per-key concurrency limit, or a monthly key budget.
4. If an upstream call fails with a 429, only that `(platform, model, key)` is cooled down and the same request moves on to the next key, then the next model. A 429 on one key does not demote the model while another key can still serve it (#454).

So the pool for one model is **keys x per-key limit**. Each key's limits are tracked separately, and nothing is shared between keys unless the provider shares it.

## Why more keys do not always mean more capacity

- **Google meters free-tier quota per Cloud project, not per key.** Keys created in the same project share one budget. Twelve keys from one project give the capacity of one key, and the local ledger (which assumes every key is independent) will dispatch requests that Google then answers with 429. Create each key in its own project.
- **Google free-tier daily limits are small and per model.** The catalog seeds `rpd_limit = 20` for the Gemini Flash / Flash-Lite / 3.x preview rows, which is what probing showed in 2026. The pool for `gemini-3.1-flash-lite-preview` is therefore roughly `20 x <independent projects>` requests a day, and every Gemini model has its own separate 20. The Gemma rows (`gemma-4-31b-it`, `gemma-4-26b-a4b-it`) are seeded at 1000 a day per key.
- **Google resets daily quotas at midnight Pacific.** The local ledger counts Google's `rpd` / `tpd` from the last Pacific midnight. Before this change it used a sliding 24h window, which kept a key benched for up to a day after Google had already reset it.
- **A pinned model has a pool of exactly that model.** Once all its keys are spent, the request fails with 429 instead of trying another model. Name fallbacks or use a chain if another model is acceptable.

## Falling back to other models

Use any of these, from most to least explicit:

| Mechanism | How | Behaviour |
|---|---|---|
| `X-Fallback-Models` header | `model: gemini-3-flash-preview` plus `X-Fallback-Models: gemini-2.5-flash, gpt-oss-120b, auto` | The pinned model's whole key pool is tried first. After that each fallback id is tried as its own lower tier, in order. `auto` / `auto:<chain>` adds that chain as the last resort. Unknown or disabled ids are skipped. Up to 8 ids. Available on `/v1/chat/completions`. |
| Named chain | `model: auto:judge` | Routes over a chain you build on the dashboard's Fallback page. See [Named fallback chains](fallback/01-named-chains.md). |
| `auto` | `model: auto` | The router scores every enabled model in the active chain. |

## Discovering what can serve right now

- `GET /v1/models?execution_status=ready` lists only models with at least one key that can serve a request now. That means not scoped away, not cooling down, and inside its rate windows. `?available=true` is weaker: it only checks that an enabled key exists.
- `GET /v1/capacity` (unified API key) reports per model and per key: `keys_total`, `keys_ready`, `requests_today`, `daily_capacity` (local ledger: `rpd_limit x healthy keys`), `retry_at`, and for each key its `label`, `status`, `requests_last_minute`, `requests_today`, `cooldown_until`, `cooldown_source`, `blocked_until` and the last redacted upstream error. Key values are never included. Filters: `?model=<model_id>`, `?platform=<platform>`, `?only_blocked=true`.
- `GET /v1/providers` and `GET /v1/quota-forecast` give the platform-level rollup.

## Exhaustion responses

When no key can serve a request, the response is `429` with `Retry-After` and `error.retryAtMs`. The retry time is now taken from the candidates of **this** request: the soonest cooldown expiry, the end of the blocking rate window, or the next daily reset (midnight Pacific for Google). Before this change a request blocked only by the local `rpd` ledger got no retry time, and a cooldown on some unrelated model could be reported instead.

## Knobs

| Knob | Where | Effect |
|---|---|---|
| More keys, each in its own provider account or project | `FREEAPI_CONFIG_JSON` (each key needs a unique `label`) or dashboard | Adds `rpd_limit` (and rpm/tpm) per key to every model of that platform. |
| `rpd_limit`, `rpm_limit`, `tpm_limit`, `tpd_limit` per model | Dashboard Models page / `PUT /api/models/:id` | The local pre-throttle. Too low wastes real quota; too high only costs an upstream 429, which cools that key down. Limits are also learned from provider error bodies. |
| `PROVIDER_DAILY_REQUEST_CAP_<PLATFORM>` / `PROVIDER_MINUTE_REQUEST_CAP_<PLATFORM>` / `PROVIDER_DAILY_TOKEN_CAP_<PLATFORM>` | env | Account-wide caps per key across all models; `0` disables a default cap. |
| Cooldown ceiling (`routing_cooldown_ceiling_ms`) | Dashboard settings | Caps heuristic cooldowns. Provider-stated reset times are still honoured. |
| Key model scope | Key settings | Restricts a key to listed models. |
| `X-Fallback-Models` | request header | Per-request sibling fallback, described above. |
