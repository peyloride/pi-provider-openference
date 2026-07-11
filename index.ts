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
}
