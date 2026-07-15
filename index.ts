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
 * Resilience to Openference's intermittent provider errors (e.g. transient
 * 400 invalid_request_error that succeeds on retry) is handled in two layers:
 *
 *   1. In-stream retry (retry-stream.ts) — primary. Wraps the provider's
 *      streamSimple and retries a failed attempt before any content is emitted.
 *      Scoped to Openference via a provider-private api id below, so the
 *      global openai-completions handler (openai/xai/groq/…) is untouched.
 *   2. message_end normalizer (this file) — backstop. If every in-stream
 *      attempt fails, rewrites the finalized error so pi's own turn-level
 *      retry fires.
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

// Re-export the shared classifier + allowlist so tests importing from
// index.ts keep working, and so the two retry layers share one source of truth.
export {
  RETRYABLE_ERRORS,
  STREAM_RETRYABLE_ERRORS,
  RETRYABLE_PREFIX,
  retryableErrorFor,
  rewriteForRetry,
  isRetryableStreamError,
  type RetryableError,
  type RetryableProbeMessage,
} from "./retry.ts";

// Value import for local use in the message_end handler below.
import { rewriteForRetry } from "./retry.ts";

import { createRetryStream, type BaseStreamFn } from "./retry-stream.ts";

// The raw OpenAI-completions streamer this provider wraps.
//
// Reachability: pi's extension loader (jiti) only resolves the compat/oauth
// entries of @earendil-works/pi-ai (it aliases them to compat.js / oauth.js).
// Subpath imports like "@earendil-works/pi-ai/api/openai-completions" do NOT
// resolve under jiti (mangled to "compat.js/api/..."), so we cannot import
// the streamer from its own api entry. compat.js DOES re-export it via
// legacy-api-aliases as `streamSimpleOpenAICompletions`, so we pull it from
// the compat specifier (which jiti aliases) instead.
//
// Type/runtime split: compat.d.ts omits that legacy re-export, so tsc doesn't
// know the binding exists — access it via a cast. Verified (native import)
// that this binding is the RAW streamer (not the compat dispatcher, not
// api-guarded), so openference-completions models flow through unchanged.
import * as piAiCompat from "@earendil-works/pi-ai/compat";
const openaiStreamSimple = (piAiCompat as unknown as {
  streamSimpleOpenAICompletions: BaseStreamFn;
}).streamSimpleOpenAICompletions;

/**
 * Provider-private api id. Registering streamSimple under a *custom* api id
 * (instead of overriding the builtin "openai-completions") is what scopes the
 * retry wrapper to Openference only — see retry-stream.ts. The streamer is
 * the real OpenAI-completions one; only the routing key is custom.
 */
export const OPENFERENCE_API = "openference-completions";

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
    api: OPENFERENCE_API,
    authHeader: true,
    headers: { "User-Agent": "pi/openference" },
    models: models.map(toModelConfig),
    // Primary resilience layer: bounded in-stream retry for transient provider
    // errors, scoped to this provider via OPENFERENCE_API. See retry-stream.ts.
    streamSimple: createRetryStream(openaiStreamSimple),
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

  // Backstop layer: route selected Openference transient errors into pi's
  // built-in auto-retry by rewriting errorMessage to a phrase pi's classifier
  // already treats as retryable ("provider returned error"). Only fires when
  // the in-stream retry (above) exhausted its budget. The pure decision lives
  // in retry.ts (retryableErrorFor / rewriteForRetry) — see that file for the
  // allowlist and how to add/remove a retryable error class.
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
