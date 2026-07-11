/**
 * Auth helpers for Openference.
 *
 * Openference API keys are opaque strings (no fixed prefix, no OAuth server)
 * created from the dashboard at openference.com. They do not expire, so we
 * model them as OAuth credentials with a far-future expiry so pi's auth
 * refresh never fires.
 *
 * Two resolution paths:
 *
 * 1. Startup (in the async factory, before a session context exists):
 *    Read any stored credential directly from auth.json, falling back to the
 *    OPENFERENCE_API_KEY env var. This lets model discovery hit GET /v1/models
 *    with the right key on the very first load.
 *
 * 2. Runtime (inside event handlers / tools, where ctx is available):
 *    Use ctx.modelRegistry.getApiKeyForProvider("openference") — the canonical
 *    resolution that checks the stored OAuth credential first, then the env-var
 *    apiKey config. This is the same pattern used by the umans provider.
 */

import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const API_KEY_ENV = "OPENFERENCE_API_KEY";

/** A credential stored under the `openference` key in auth.json. */
interface StoredCredential {
  type?: "api_key" | "oauth";
  access?: string;
  key?: string;
  refresh?: string;
  expires?: number;
}

/**
 * Read the stored Openference API key directly from auth.json.
 * Used only at startup (before a session context exists). At runtime, prefer
 * ctx.modelRegistry.getApiKeyForProvider("openference").
 * Returns undefined if no credential is stored or the file is missing.
 */
export function readStoredApiKey(): string | undefined {
  try {
    if (!existsSync(AUTH_FILE)) return undefined;
    const raw = readFileSync(AUTH_FILE, "utf-8");
    const data = JSON.parse(raw) as Record<string, StoredCredential>;
    const cred = data["openference"];
    if (!cred) return undefined;
    if (cred.access) return cred.access;
    if (cred.key) return cred.key;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the API key for startup model discovery.
 * Priority: stored credential (from /login) → env var.
 */
export function resolveStartupApiKey(): string | undefined {
  return readStoredApiKey() ?? process.env[API_KEY_ENV]?.trim();
}

/** Far-future expiry so pi never attempts a token refresh (keys don't expire). */
export const FAR_FUTURE_EXPIRES = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
