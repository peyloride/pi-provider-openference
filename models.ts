/**
 * Openference model discovery + pricing catalog.
 *
 * Openference exposes a curated, OpenAI-compatible model pool at
 * https://api.openference.com/v1. The `/v1/models` endpoint returns only
 * model IDs (no pricing/context metadata), so we:
 *   1. Fetch IDs dynamically at load time (async factory).
 *   2. Look up per-token pricing from a local catalog keyed by id substring.
 *   3. Fall back to a small static catalog when the API is unreachable or no
 *      API key is configured yet, so `/model` still shows something useful.
 *
 * Pricing is per 1M tokens (USD), sourced from openference.com/models.
 * Extend PRICING_CATALOG as new models are published. Unknown ids default to
 * zero rates (cost surfaced as "unpriced" in usage reports).
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const OPENFERENCE_BASE_URL = "https://api.openference.com/v1";
export const OPENFERENCE_PROVIDER = "openference";

interface PriceEntry {
  match: RegExp;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  label: string;
}

/**
 * Per-million-token USD rates. Order matters: the first matching entry wins,
 * so put more specific patterns (e.g. deepseek-r1) before generic ones
 * (e.g. deepseek).
 */
const PRICING_CATALOG: PriceEntry[] = [
  { match: /deyin/i, input: 0.3675, output: 1.0, label: "DeYin (auto-route)" },
  { match: /deepseek.*(r1|reasoner)|r1/i, input: 0.43, output: 0.8, label: "DeepSeek R1" },
  { match: /deepseek/i, input: 0.14, output: 0.28, label: "DeepSeek V3" },
  { match: /glm.*5\.?2|glm-?5/i, input: 1.4, output: 4.4, label: "GLM-5.2 (Z.ai)" },
  { match: /glm|z\.?ai|zhipu/i, input: 1.4, output: 4.4, label: "Z.ai GLM" },
  { match: /kimi|moonshot/i, input: 0.6, output: 2.5, label: "Kimi" },
  { match: /qwen.*(max|coder)/i, input: 0.65, output: 3.25, label: "Qwen Max" },
  { match: /qwen/i, input: 0.4, output: 1.6, label: "Qwen" },
  { match: /mistral|magistral|codestral/i, input: 0.3, output: 1.2, label: "Mistral" },
  { match: /minimax|abab/i, input: 0.7, output: 2.8, label: "MiniMax" },
];

interface ResolvedPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  label: string;
  known: boolean;
}

export function priceFor(id: string): ResolvedPrice {
  const entry = PRICING_CATALOG.find((e) => e.match.test(id));
  if (!entry) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, label: "Unknown", known: false };
  }
  return {
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead ?? 0,
    cacheWrite: entry.cacheWrite ?? 0,
    label: entry.label,
    known: true,
  };
}

/** Reasoning-capable model ids (enables pi thinking-level controls). */
function isReasoning(id: string): boolean {
  return /(r1|reasoner|reasoning|thinking|glm.*5|o1|o3|qwen.*qvq)/i.test(id);
}

/** Pretty display name from a raw model id. */
function prettyName(id: string): string {
  const price = priceFor(id);
  const label = price.known ? price.label : "Openference";
  return `${id} (${label})`;
}

/** Conservative maxTokens per model family; Openference advertises 1M context. */
function maxTokensFor(id: string): number {
  if (/glm/i.test(id)) return 131_072;
  if (/deepseek.*(r1|reasoner)|r1/i.test(id)) return 32_768;
  return 16_384;
}

/** Build a pi ProviderModelConfig from a raw Openference model id. */
export function toModelConfig(id: string): ProviderModelConfig {
  const price = priceFor(id);
  return {
    id,
    name: prettyName(id),
    reasoning: isReasoning(id),
    input: ["text", "image"],
    cost: {
      input: price.input,
      output: price.output,
      cacheRead: price.cacheRead,
      cacheWrite: price.cacheWrite,
    },
    contextWindow: 1_000_000,
    maxTokens: maxTokensFor(id),
  };
}

/** Static fallback shown when /v1/models is unreachable (e.g. no API key yet). */
export const FALLBACK_MODEL_IDS = ["GLM-5.2", "deepseek-v3", "deepseek-r1", "qwen-max"];

/** Fetch live model ids from GET /v1/models. Returns [] on failure. */
export async function fetchModelIds(apiKey: string | undefined): Promise<string[]> {
  const headers: Record<string, string> = { "User-Agent": "pi/openference" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${OPENFERENCE_BASE_URL}/models`, { headers });
  if (!res.ok) {
    throw new Error(`GET /v1/models → HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (json.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return ids;
}
