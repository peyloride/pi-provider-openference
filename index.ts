/**
 * Openference provider for pi.
 *
 * Registers the Openference gateway (https://api.openference.com/v1) as a pi
 * provider using its OpenAI-compatible /v1/chat/completions endpoint. Models
 * and their context/max-tokens/reasoning metadata are fetched live from
 * GET /v1/models at load time.
 *
 * Auth is via /login: the key is prompted, validated against /v1/models, and
 * stored in ~/.pi/agent/auth.json. No env var needed.
 *
 * Usage:
 *   /login openference
 *   /model openference/GLM-5.2
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
  FALLBACK_MODELS,
  OPENFERENCE_BASE_URL,
  OPENFERENCE_PROVIDER,
  fetchModels,
  toModelConfig,
  type OpenferenceModelInfo,
} from "./models.ts";
import { FAR_FUTURE_EXPIRES, resolveStartupApiKey } from "./auth.ts";

// ---------------------------------------------------------------------------
// Retryable error classification (module-scope + exported for tests).
// The message_end handler below is a thin wrapper around these pure helpers.
// Tests import them directly — no pi runtime required.
// ---------------------------------------------------------------------------

export interface RetryableError {
  /** Human-readable label; surfaced in the rewritten errorMessage for logs. */
  label: string;
  /** Tested (case-insensitive) against the full errorMessage. */
  pattern: RegExp;
}

/**
 * Allowlist of error classes pi does NOT retry by default, surfaced here so
 * pi's built-in exponential-backoff retry fires for them.
 *
 * pi ALREADY retries (don't add — redundant): 429, 500, 502, 503, 504, 524,
 * "rate limit", "too many requests", "overloaded", "service unavailable",
 * "fetch failed", "socket hang up", "connection refused", "timeout",
 * "stream ended without finish_reason", "network_error".
 *
 * This list is for errors pi does NOT retry (e.g. intermittent 400s that
 * Openference's gateway surfaces as client errors). Be specific — an
 * over-broad pattern would retry genuinely broken requests.
 *
 * TO ADD OR REMOVE A RETRYABLE ERROR CLASS: append or delete an entry. No
 * other code changes needed.
 */
export const RETRYABLE_ERRORS: RetryableError[] = [
  {
    // Openference occasionally 400s a request that succeeds on the next attempt.
    // Match the status + a distinctive token it carries (the error code OR its
    // specific wording), not bare "400", so deterministic client errors are
    // not retried. The phrase is matched unquoted so trailing punctuation inside
    // the JSON message value doesn't defeat the match.
    label: "intermittent invalid_request_error (400)",
    pattern: /400[^\n]*(invalid_request_error|the request could not be processed)/i,
  },
  // { label: "<describe the transient error>", pattern: /<regex>/i },
];

/** Prefix that makes pi's retry classifier treat the message as retryable. */
export const RETRYABLE_PREFIX = "provider returned error";

/** Terminal signals pi must NOT retry (own paths: terminal or compaction). */
const TERMINAL_ERROR =
  /insufficient_quota|out of budget|quota exceeded|billing|context_length_exceeded/i;

/** Structural subset of a finalized message — enough to classify retryability. */
export interface RetryableProbeMessage {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
}

/**
 * Pure classifier: returns the matching RetryableError entry for an Openference
 * assistant error, or null when the message must NOT be rewritten.
 *
 * Returns null (i.e. no retry) when any of these hold:
 *   - not an assistant message / not an error stopReason (scope guard);
 *   - not from the openference provider (scope guard) — checked against both
 *     `message.provider` and `providerFromModel` (ctx.model?.provider), since the
 *     active model may carry the provider when the message does not;
 *   - errorMessage already rewritten (idempotency) — avoids double-wrapping;
 *   - errorMessage matches a TERMINAL_ERROR (quota / billing / overflow) —
 *     defense in depth so a future broad entry can never shadow pi's own
 *     terminal vs compaction paths.
 */
export function retryableErrorFor(
  message: RetryableProbeMessage,
  providerFromModel?: string,
): RetryableError | null {
  if (message.role !== "assistant") return null;
  if (message.stopReason !== "error") return null;

  if (
    message.provider !== OPENFERENCE_PROVIDER &&
    providerFromModel !== OPENFERENCE_PROVIDER
  )
    return null;

  const errorMessage = message.errorMessage ?? "";
  if (!errorMessage || errorMessage.startsWith(RETRYABLE_PREFIX)) return null;
  if (TERMINAL_ERROR.test(errorMessage)) return null;

  return RETRYABLE_ERRORS.find((e) => e.pattern.test(errorMessage)) ?? null;
}

/**
 * Pure: returns the rewritten errorMessage to feed pi's retry classifier, or
 * null when the message should not be rewritten. Same input → same string.
 */
export function rewriteForRetry(
  message: RetryableProbeMessage,
  providerFromModel?: string,
): string | null {
  const match = retryableErrorFor(message, providerFromModel);
  if (!match) return null;
  return `${RETRYABLE_PREFIX}: ${match.label} (treated as transient). Original: ${message.errorMessage}`;
}

// ---------------------------------------------------------------------------
// Provider registration + message_end hook
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const apiKey = resolveStartupApiKey();

  let models: OpenferenceModelInfo[] = [];
  if (apiKey) {
    try {
      models = await fetchModels(apiKey);
    } catch (err) {
      console.warn(`[openference] model discovery failed: ${(err as Error).message}`);
    }
  }
  if (models.length === 0) {
    models = FALLBACK_MODELS;
    if (!apiKey) {
      console.info("[openference] no stored credential found; run /login openference");
    }
  }

  // Both apiKey and oauth are required:
  //   - apiKey ($ENV) is the fallback for env-var users and makes the provider
  //     appear in the /login selector.
  //   - oauth provides the /login flow. getApiKey() returns the stored
  //     credential at request time, taking priority over the env var.
  pi.registerProvider(OPENFERENCE_PROVIDER, {
    name: "Openference",
    baseUrl: OPENFERENCE_BASE_URL,
    apiKey: "$OPENFERENCE_API_KEY",
    api: "openai-completions",
    authHeader: true,
    headers: { "User-Agent": "pi/openference" },
    models: models.map(toModelConfig),
    oauth: {
      name: "Openference (API key)",
      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        callbacks.onProgress?.("Create an API key at https://openference.com/dashboard");
        const key = await callbacks.onPrompt({
          message: "Openference API key:",
          placeholder: "paste your openference API key",
        });
        if (!key.trim()) throw new Error("No API key entered");

        callbacks.onProgress?.("Validating key...");
        try {
          const ids = await fetchModels(key.trim());
          if (ids.length === 0) throw new Error("key returned no models");
          callbacks.onProgress?.(`Validated: ${ids.length} models available`);
        } catch (err) {
          throw new Error(`Key validation failed: ${(err as Error).message}`);
        }

        // Keys don't expire; far-future expiry so pi never refreshes.
        return { access: key.trim(), refresh: key.trim(), expires: FAR_FUTURE_EXPIRES };
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return credentials;
      },
      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
      modifyModels(models) {
        return models;
      },
    },
  });

  // Route selected Openference transient errors into pi's built-in auto-retry
  // by rewriting errorMessage to a phrase pi's classifier already treats as
  // retryable ("provider returned error"). The pure decision lives in
  // retryableErrorFor() / rewriteForRetry() above — see those for the full
  // rationale, the allowlist, and how to add/remove a retryable error class.
  pi.on("message_end", (event, ctx) => {
    const rewrite = rewriteForRetry(event.message, ctx.model?.provider);
    if (!rewrite) return;
    return {
      message: {
        ...event.message,
        errorMessage: rewrite,
      },
    };
  });
}
