/**
 * Openference — request usage support for pi, with `/login` credential storage.
 *
 * Openference (https://openference.com) is a curated OpenAI-compatible model
 * proxy: one base URL (https://api.openference.com/v1), one API key, and
 * per-request quota against a rolling plan window plus a per-minute burst limit.
 *
 * Auth model: Openference keys are opaque, non-expiring strings created in the
 * dashboard. There is no OAuth server, so we model the key as an OAuth
 * credential with a far-future expiry. pi's `/login` flow:
 *   1. Prompts the user for their API key (secret input).
 *   2. Validates it against `GET /v1/models`.
 *   3. Stores it in `~/.pi/agent/auth.json` keyed by `openference`.
 *   4. On every request, pi calls `getApiKey(credentials)` to derive the
 *      `Authorization: Bearer` header — no env var required.
 *
 * This extension adds:
 *
 *  1. Provider + model registration with `oauth` for `/login`. On load we read
 *     any stored credential from auth.json (falling back to OPENFERENCE_API_KEY
 *     for backward compatibility) and fetch `GET /v1/models` to register every
 *     model under the `openference` provider with per-token pricing.
 *
 *  2. Request usage accounting. We hook `after_provider_response` (HTTP status,
 *     Retry-After, abuse-throttle metadata) and `message_end` (token usage +
 *     cost) to maintain a rolling ledger: billable requests (success + 4xx),
 *     5h window + 60s burst counts, per-model spend, last 429/529 event.
 *     Reconstructed from the session transcript on `session_start`.
 *
 *  3. Inspection surfaces: `/openference` command, `openference_usage` and
 *     `openference_requests` tools, footer status, expandable transcript card.
 *
 * Setup:
 *   /login                    # pick "Openference", paste your API key
 *   /model openference/GLM-5.2 # select a model
 *
 * Reference: https://docs.openference.com  (Pi guide: /docs/pi)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import { Text as PiText } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  FALLBACK_MODEL_IDS,
  OPENFERENCE_BASE_URL,
  OPENFERENCE_PROVIDER,
  fetchModelIds,
  priceFor,
  toModelConfig,
} from "./models.ts";
import {
  UsageLedger,
  computeCost,
  type UsageRecord,
  type RequestStatus,
} from "./usage.ts";
import { footerStatus, renderUsageCard } from "./render.ts";
import {
  FAR_FUTURE_EXPIRES,
  resolveStartupApiKey,
} from "./auth.ts";

const ENTRY_TYPE = "openference-usage";
const FOOTER_KEY = "openference";

function statusFromHttp(status: number, aborted: boolean): RequestStatus {
  if (aborted) return "aborted";
  if (status >= 200 && status < 300) return "success";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 529) return "upstream_error";
  if (status >= 400 && status < 500) return "client_error";
  if (status >= 500) return "upstream_error";
  return "unknown";
}

export default async function (pi: ExtensionAPI) {
  const ledger = new UsageLedger();

  // ---- 0. Resolve stored credential for model discovery --------------------
  // Read from auth.json first (set by /login), then fall back to the env var.
  const apiKey = resolveStartupApiKey();

  // ---- 1. Register provider + models + /login oauth -------------------------
  // The oauth block makes this provider appear in pi's /login menu. On login
  // we prompt for the secret key, validate it, and return it as an
  // OAuthCredentials that pi persists to auth.json. getApiKey() derives the
  // bearer token from the stored credential on every request.
  let modelIds: string[] = [];
  if (apiKey) {
    try {
      modelIds = await fetchModelIds(apiKey);
    } catch (err) {
      console.warn(`[openference] model discovery failed: ${(err as Error).message}`);
    }
  }
  if (modelIds.length === 0) {
    modelIds = FALLBACK_MODEL_IDS;
    if (apiKey) {
      console.warn(
        `[openference] using fallback model list: ${FALLBACK_MODEL_IDS.join(", ")}`,
      );
    } else {
      console.info(
        "[openference] no stored credential found — run /login and pick Openference",
      );
    }
  }

  // NOTE: both `apiKey` and `oauth` are required.
  //   - `apiKey` ($ENV) is the fallback for env-var users and, crucially,
  //     makes the provider appear in the /login provider selector. Without it
  //     the provider is invisible to /login (only oauth-registered providers
  //     that also have an apiKey entry show up as api_key login options).
  //   - `oauth` provides the /login flow: login() collects + validates the
  //     key, and getApiKey() returns the stored credential at request time,
  //     taking priority over the env-var fallback (see model-registry.js:
  //     apiKeyFromAuthStorage ?? providerConfig.apiKey).
  pi.registerProvider(OPENFERENCE_PROVIDER, {
    name: "Openference",
    baseUrl: OPENFERENCE_BASE_URL,
    apiKey: "$OPENFERENCE_API_KEY",
    api: "openai-completions",
    authHeader: true,
    headers: { "User-Agent": "pi/openference" },
    models: modelIds.map(toModelConfig),
    oauth: {
      name: "Openference (API key)",
      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        callbacks.onProgress?.(
          "Create an API key at https://openference.com/dashboard",
        );
        const key = await callbacks.onPrompt({
          message: "Openference API key:",
          placeholder: "paste your openference API key",
        });
        if (!key.trim()) {
          throw new Error("No API key entered");
        }

        // Validate the key against GET /v1/models before storing it.
        callbacks.onProgress?.("Validating key…");
        try {
          const ids = await fetchModelIds(key.trim());
          if (ids.length === 0) {
            throw new Error("key valid but returned no models");
          }
          callbacks.onProgress?.(
            `Validated — ${ids.length} models available`,
          );
        } catch (err) {
          throw new Error(
            `Key validation failed (GET /v1/models): ${(err as Error).message}`,
          );
        }

        // Keys don't expire; use a far-future expiry so pi never refreshes.
        // Store the key in `access` (the field getApiKey returns).
        return {
          access: key.trim(),
          refresh: key.trim(),
          expires: FAR_FUTURE_EXPIRES,
        };
      },
      async refreshToken(
        credentials: OAuthCredentials,
      ): Promise<OAuthCredentials> {
        // Openference keys never expire; return as-is.
        return credentials;
      },
      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
      // modifyModels is synchronous and runs after /login completes. We can't
      // fetch /v1/models here (no async), so we return the models unchanged;
      // the async factory already discovered them at startup, and
      // completeProviderAuthentication re-registers from provider config.
      // If the key is model-restricted, the user can /reload to re-discover.
      modifyModels(models) {
        return models;
      },
    },
  });

  // ---- 2. Reconstruct ledger from session transcript -----------------------
  pi.on("session_start", async (_event, ctx) => {
    ledger.reset();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message as {
        role?: string;
        provider?: string;
        model?: string;
        usage?: any;
        timestamp?: number;
        stopReason?: string;
      };
      if (msg?.role !== "assistant") continue;
      if (msg.provider !== OPENFERENCE_PROVIDER) continue;
      if (!msg.usage) continue;

      const rates = priceFor(msg.model ?? "");
      const cost = computeCost(
        {
          input: msg.usage.input ?? 0,
          output: msg.usage.output ?? 0,
          cacheRead: msg.usage.cacheRead ?? 0,
          cacheWrite: msg.usage.cacheWrite ?? 0,
        },
        rates,
      );
      const status: RequestStatus =
        msg.stopReason === "aborted" ? "aborted" : "success";

      ledger.recordUsage({
        timestamp: new Date(msg.timestamp ?? Date.now()).toISOString(),
        model: msg.model ?? "(unknown)",
        provider: OPENFERENCE_PROVIDER,
        status,
        inputTokens: msg.usage.input ?? 0,
        outputTokens: msg.usage.output ?? 0,
        cacheReadTokens: msg.usage.cacheRead ?? 0,
        cacheWriteTokens: msg.usage.cacheWrite ?? 0,
        totalTokens:
          msg.usage.totalTokens ?? (msg.usage.input ?? 0) + (msg.usage.output ?? 0),
        inputCost: cost.inputCost,
        outputCost: cost.outputCost,
        totalCost: cost.totalCost,
        httpStatus: null,
      });
    }
    refreshFooter(ctx);
  });

  // ---- 3a. Capture HTTP status + rate-limit bodies -------------------------
  const pendingStatus = new Map<
    string,
    { status: number; headers: Record<string, string> }
  >();

  pi.on("after_provider_response", async (event, _ctx) => {
    ledger.recordStatus(event.status, event.headers);
    if (event.status === 429 || event.status === 529) {
      pendingStatus.set("last", { status: event.status, headers: event.headers });
    }
  });

  // ---- 3b. Extract usage from completed assistant messages -----------------
  pi.on("message_end", async (event, ctx) => {
    const msg = event.message as {
      role?: string;
      provider?: string;
      model?: string;
      usage?: any;
      timestamp?: number;
      stopReason?: string;
    };
    if (msg?.role !== "assistant") return;
    if (msg.provider !== OPENFERENCE_PROVIDER) return;

    const usage = msg.usage ?? {};
    const rates = priceFor(msg.model ?? "");
    const cost = computeCost(
      {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
      },
      rates,
    );

    const pending = pendingStatus.get("last");
    const httpStatus = pending?.status ?? null;
    const baseStatus = statusFromHttp(
      httpStatus ?? 200,
      msg.stopReason === "aborted",
    );

    // If we saw a 429/529, override the status even if a usage block returned.
    const effectiveStatus: RequestStatus =
      httpStatus === 429
        ? "rate_limited"
        : httpStatus === 529
          ? "upstream_error"
          : baseStatus;

    if (pending) pendingStatus.delete("last");

    ledger.recordUsage({
      timestamp: new Date(msg.timestamp ?? Date.now()).toISOString(),
      model: msg.model ?? "(unknown)",
      provider: OPENFERENCE_PROVIDER,
      status: effectiveStatus,
      inputTokens: usage.input ?? 0,
      outputTokens: usage.output ?? 0,
      cacheReadTokens: usage.cacheRead ?? 0,
      cacheWriteTokens: usage.cacheWrite ?? 0,
      totalTokens:
        usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
      inputCost: cost.inputCost,
      outputCost: cost.outputCost,
      totalCost: cost.totalCost,
      httpStatus,
    });
    refreshFooter(ctx);
  });

  function refreshFooter(ctx: any) {
    if (!ctx?.hasUI) return;
    const snap = ledger.snapshot();
    ctx.ui.setStatus(FOOTER_KEY, footerStatus(snap));
  }

  // Canonical runtime API-key resolution (same pattern as the umans provider):
  // checks the stored OAuth credential first, then the env-var apiKey config.
  async function resolveApiKey(ctx?: any): Promise<string | undefined> {
    const envKey = process.env.OPENFERENCE_API_KEY?.trim();
    if (envKey) return envKey;
    try {
      return await ctx?.modelRegistry?.getApiKeyForProvider?.(
        OPENFERENCE_PROVIDER,
      );
    } catch {
      return undefined;
    }
  }

  // ---- 4. Transcript card renderer -----------------------------------------
  pi.registerEntryRenderer(ENTRY_TYPE, (entry, { expanded }) => {
    const data = entry.data as { snapshot: any } | undefined;
    if (!data?.snapshot) {
      return new PiText("⚡ Openference: no usage data yet", 0, 0);
    }
    return renderUsageCard(data.snapshot, expanded);
  });

  // ---- 5. /openference command ---------------------------------------------
  pi.registerCommand("openference", {
    description: "Show Openference request usage and cost summary",
    handler: async (_args, ctx) => {
      const snap = ledger.snapshot();
      const t = snap.totals;
      const lines = [
        "⚡ Openference request usage",
        `  Billable requests: ${t.billableRequests} / ${t.requests} total`,
        `    ✓ ${t.success}  ·  4xx ${t.clientErrors}  ·  5xx ${t.upstreamErrors}  ·  429 ${t.rateLimited}  ·  aborted ${t.aborted}`,
        `  Rolling window (5h): ${snap.windowRequests} billable`,
        `  Burst window (60s): ${snap.burstRequests} billable`,
        `  Tokens: ${t.totalTokens} (in ${t.inputTokens}, out ${t.outputTokens}, cache read ${t.cacheReadTokens}, write ${t.cacheWriteTokens})`,
        `  Estimated cost: $${t.totalCost.toFixed(4)} (in $${t.inputCost.toFixed(4)}, out $${t.outputCost.toFixed(4)})`,
      ];
      const rl = snap.rateLimit;
      if (rl.lastStatus != null) {
        lines.push(
          `  Last rate-limit: HTTP ${rl.lastStatus}` +
            (rl.wasAbuseThrottle ? " (abuse throttle)" : "") +
            (rl.retryAfterSeconds != null ? ` retry in ${rl.retryAfterSeconds}s` : "") +
            (rl.maxRpm != null ? ` ≤${rl.maxRpm} rpm` : ""),
        );
      }
      if (Object.keys(snap.byModel).length > 0) {
        lines.push("  Per model:");
        for (const [model, m] of Object.entries(snap.byModel).sort(
          (a, b) => b[1].totalCost - a[1].totalCost,
        )) {
          lines.push(
            `    ${model}: ${m.billableRequests}/${m.requests} req · $${m.totalCost.toFixed(4)}`,
          );
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");

      if (ctx.hasUI) {
        pi.appendEntry(ENTRY_TYPE, { snapshot: snap });
      }
    },
  });

  // ---- 6. openference_usage tool (LLM-callable) ----------------------------
  pi.registerTool({
    name: "openference_usage",
    label: "Openference Usage",
    description:
      "Return the current Openference request usage snapshot: total + per-model request counts, token usage, estimated USD cost, rolling 5h window and 60s burst counts, and the last rate-limit (429/529) event with retry hints. Use when the user asks about Openference spend, quota, rate limits, or how many requests have been made.",
    promptSnippet: "Inspect Openference request usage, cost, and rate-limit status",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const snap = ledger.snapshot();
      refreshFooter(ctx);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                summary: {
                  billableRequests: snap.totals.billableRequests,
                  totalRequests: snap.totals.requests,
                  totalCostUsd: Number(snap.totals.totalCost.toFixed(6)),
                  totalTokens: snap.totals.totalTokens,
                  window5hRequests: snap.windowRequests,
                  burst60sRequests: snap.burstRequests,
                },
                rateLimit: snap.rateLimit.lastStatus ? snap.rateLimit : null,
                byModel: Object.fromEntries(
                  Object.entries(snap.byModel).map(([k, v]) => [
                    k,
                    { ...v, totalCostUsd: Number(v.totalCost.toFixed(6)) },
                  ]),
                ),
                recent: snap.recent.slice(0, 5),
              },
              null,
              2,
            ),
          },
        ],
        details: { snapshot: snap },
      };
    },
  });

  // ---- 7. openference_requests tool ----------------------------------------
  pi.registerTool({
    name: "openference_requests",
    label: "Openference Recent Requests",
    description:
      "Return recent Openference request records (last 15): timestamp, model, status (success/client_error/upstream_error/rate_limited/aborted), token counts, cost, and HTTP status. Use to inspect individual requests or diagnose rate limiting.",
    parameters: Type.Object({
      model: Type.Optional(
        Type.String({
          description: "Filter records to a substring match on model id.",
        }),
      ),
      status: Type.Optional(
        Type.String({
          description:
            "Filter by status: success, client_error, upstream_error, rate_limited, aborted.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const snap = ledger.snapshot();
      let records = snap.recent;
      if (params.model) {
        records = records.filter((r) =>
          r.model.toLowerCase().includes(params.model!.toLowerCase()),
        );
      }
      if (params.status) {
        records = records.filter((r) => r.status === params.status);
      }
      refreshFooter(ctx);
      return {
        content: [
          { type: "text", text: JSON.stringify(records, null, 2) },
        ],
        details: { records },
      };
    },
  });
}
