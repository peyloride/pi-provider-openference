/**
 * Auth helpers for Openference.
 *
 * Openference API keys are opaque, non-expiring strings created in the
 * dashboard. We model them as OAuth credentials with a far-future expiry so
 * pi's token refresh never fires.
 *
 * At startup (before a session context exists), we read any stored credential
 * directly from auth.json to discover models. Falls back to the
 * OPENFERENCE_API_KEY env var.
 */

import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const API_KEY_ENV = "OPENFERENCE_API_KEY";

interface StoredCredential {
  type?: "api_key" | "oauth";
  access?: string;
  key?: string;
}

export function resolveStartupApiKey(): string | undefined {
  return readStoredApiKey() ?? process.env[API_KEY_ENV]?.trim();
}

function readStoredApiKey(): string | undefined {
  try {
    if (!existsSync(AUTH_FILE)) return undefined;
    const raw = readFileSync(AUTH_FILE, "utf-8");
    const data = JSON.parse(raw) as Record<string, StoredCredential>;
    const cred = data["openference"];
    return cred?.access ?? cred?.key;
  } catch {
    return undefined;
  }
}

/** Far-future expiry so pi never attempts a token refresh (keys don't expire). */
export const FAR_FUTURE_EXPIRES = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
