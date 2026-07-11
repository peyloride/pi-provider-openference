/**
 * Openference model discovery + pricing.
 *
 * GET /v1/models returns model ids plus capability metadata:
 *   context_length, max_output_tokens, reasoning.supported_efforts
 *
 * It does not return pricing, so per-token rates come from a local catalog
 * keyed by id substring. Extend PRICING_CATALOG as new models appear.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const OPENFERENCE_BASE_URL = "https://api.openference.com/v1";
export const OPENFERENCE_PROVIDER = "openference";

/** Raw shape of one entry in the /v1/models response. */
export interface OpenferenceModelInfo {
  id: string;
  context_length?: number;
  max_output_tokens?: number | null;
  reasoning?: { supported_efforts?: string[] } | null;
}

interface PriceEntry {
  match: RegExp;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  label: string;
}

/**
 * Per-million-token USD rates. Order matters: first match wins, so put
 * specific patterns (deepseek-r1) before generic ones (deepseek).
 * Sourced from openference.com/models.
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

function priceFor(id: string) {
  const entry = PRICING_CATALOG.find((e) => e.match.test(id));
  if (!entry) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, label: "Openference" };
  }
  return {
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead ?? 0,
    cacheWrite: entry.cacheWrite ?? 0,
    label: entry.label,
  };
}

/** Build a pi ProviderModelConfig from a live /v1/models entry. */
export function toModelConfig(info: OpenferenceModelInfo): ProviderModelConfig {
  const id = info.id;
  const price = priceFor(id);
  const efforts = info.reasoning?.supported_efforts ?? [];
  const reasoning = efforts.length > 0;

  return {
    id,
    name: `${id} (${price.label})`,
    reasoning,
    input: ["text", "image"],
    cost: {
      input: price.input,
      output: price.output,
      cacheRead: price.cacheRead,
      cacheWrite: price.cacheWrite,
    },
    contextWindow: info.context_length ?? 1_000_000,
    maxTokens: info.max_output_tokens ?? 16_384,
  };
}

/** Fallback when /v1/models is unreachable (e.g. no API key yet). */
export const FALLBACK_MODELS: OpenferenceModelInfo[] = [
  { id: "GLM-5.2", context_length: 1_000_000, max_output_tokens: 131_072, reasoning: { supported_efforts: ["high", "medium", "low"] } },
  { id: "DeepSeek-V4-Pro", context_length: 1_000_000, max_output_tokens: 131_072, reasoning: { supported_efforts: ["max", "high", "medium", "low"] } },
  { id: "Qwen3.7 Plus", context_length: 1_000_000, max_output_tokens: 65_536, reasoning: { supported_efforts: ["max", "high", "medium", "low"] } },
];

/** Fetch live models from GET /v1/models. Throws on failure. */
export async function fetchModels(apiKey: string | undefined): Promise<OpenferenceModelInfo[]> {
  const headers: Record<string, string> = { "User-Agent": "pi/openference" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${OPENFERENCE_BASE_URL}/models`, { headers });
  if (!res.ok) {
    throw new Error(`GET /v1/models -> HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: OpenferenceModelInfo[] };
  return (json.data ?? []).filter((m) => typeof m.id === "string" && m.id.length > 0);
}
