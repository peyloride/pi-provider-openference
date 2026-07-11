# openference-usage

A [pi](https://pi.dev) extension that adds **Openference** support with
**request usage tracking** and a proper **`/login` flow**.

Installed globally at `~/.pi/agent/extensions/openference-usage/`, so it loads
from every project (not project-local).

Openference (https://openference.com/docs) is a curated OpenAI-compatible model
proxy: one base URL (`https://api.openference.com/v1`), one API key, billed per
request against a rolling plan window plus a per-minute burst limit.

## Auth: `/login`, not env vars

Openference keys are opaque, non-expiring strings created in the
[dashboard](https://openference.com/dashboard). There is no OAuth server, so we
model the key as an OAuth credential with a far-future expiry. This means the
key is stored in pi's encrypted credential store (`~/.pi/agent/auth.json`),
**not** an environment variable.

```bash
# inside pi:
/login openference       # paste your API key when prompted
/model openference/GLM-5.2
```

The provider is registered with **both** `apiKey: "$OPENFERENCE_API_KEY"`
(env-var fallback + makes the provider appear in the `/login` selector) and an
`oauth` block (the `/login` flow). The `/login` flow:
1. pi prompts for the API key (via the provider's `oauth.login`)
2. The extension **validates** the key against `GET /v1/models`
3. On success, pi stores it in `~/.pi/agent/auth.json` keyed by `openference`
4. On every request, `oauth.getApiKey()` returns the stored key → pi sends
   `Authorization: Bearer <key>` (via `authHeader: true`). The stored
   credential takes priority over the env-var fallback.
5. `refreshToken` is a no-op (keys don't expire)

Backward compat: if `OPENFERENCE_API_KEY` is set in the environment, it's used
for startup model discovery when no stored credential exists, but `/login`
remains the primary path.

## What it does

1. **Provider + model registration** — On load (async factory) it reads any
   stored credential from `auth.json` (falling back to `OPENFERENCE_API_KEY`)
   and fetches `GET /v1/models` to register every returned model under the
   `openference` provider, with per-token pricing, 1M context, and reasoning
   detection.

2. **Request usage accounting** — Hooks `after_provider_response` (HTTP status,
   `Retry-After`, abuse-throttle body fields) and `message_end` (token usage +
   cost) to maintain a rolling ledger of:
   - billable requests (success + 4xx, per Openference's "what counts" rule;
     502/529 upstream errors are excluded)
   - 5h window + 60s burst counts
   - per-model token spend and USD cost
   - the last 429/529 event with retry hints and `max_rpm`

   The ledger is reconstructed from the session transcript on `session_start`
   so it survives `/reload` and `/resume`.

3. **Inspection surfaces** —
   - `/openference` command → summary notification + expandable transcript card
   - `openference_usage` tool → JSON snapshot returned to the LLM
   - `openference_requests` tool → recent request records (filterable)
   - footer status → live `⚡OF <req> · <cost>` line

## First-time setup

> **Restart pi** after installing/updating the extension so it picks up the
> provider registration. Then:

```bash
# Direct (recommended) — skips the auth-type selector:
/login openference
#   → paste your API key (from openference.com/dashboard)
#   → the extension validates it against GET /v1/models and registers all models

/model openference/<id>   # or Ctrl+P to cycle
```

If you run bare `/login` instead, Openference appears under **“Use a
subscription”** (not “Use an API key”). That label is pi’s generic name for the
OAuth login path; Openference keys are still plain API keys stored in
`auth.json`. Pick “Use a subscription” → “Openference (API key)”.

If you add the key later or change its model restrictions in the dashboard,
run `/reload` to re-discover the full model list.

If you add the key later or change its model restrictions in the dashboard,
run `/reload` to re-discover the full model list.

## Files

- `index.ts` — factory: provider registration with `oauth`, event hooks, tools, command
- `models.ts` — model discovery + pricing catalog
- `usage.ts` — `UsageLedger`, status classification, cost computation
- `render.ts` — footer string + expandable transcript card
- `auth.ts` — read stored credential from `auth.json` for startup discovery

## Why "request usage"

Openference's quota model is **per request**, not per token, for its plan
allowance (e.g. 1500 requests / 5h on Pro). Tokens drive pay-as-you-go cost;
requests drive quota. This extension surfaces both: request counts for quota
tracking, and token + USD totals for spend.

## References

- Pi integration guide: https://openference.com/docs/pi
- API reference: https://docs.openference.com/api-reference
- Rate limits: https://docs.openference.com/api-reference/rate-limits
- Models: https://openference.com/models
