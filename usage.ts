/**
 * Usage accounting for Openference.
 *
 * Openference bills per-request against a rolling-window plan quota plus a
 * per-minute burst limit (see docs.openference.com/api-reference/rate-limits).
 * Upstream/capacity errors (502, 529) do NOT count toward quota; 4xx client
 * errors and successes DO count.
 *
 * This module keeps an in-memory ledger of:
 *   - per-request usage (tokens + cost) extracted from assistant messages
 *   - per-request status (success / client_error / upstream_error / rate_limited)
 *   - rolling-window request counts (5h plan window + 60s burst window)
 *   - the last 429/529 response headers + retry hints
 *
 * State is ephemeral per session. It is reconstructed from the session
 * transcript on `session_start` (see index.ts) so it survives `/reload` and
 * `/resume`. Use the `openference_usage` and `openference_requests` tools
 * (or the `/openference` command) to inspect it.
 */

export type RequestStatus =
  | "success"
  | "client_error" // 4xx → counts against quota
  | "upstream_error" // 502/529 → does NOT count against quota
  | "rate_limited" // 429 → counts against quota (plan/burst) unless abuse throttle
  | "aborted"
  | "unknown";

export interface UsageRecord {
  /** ISO timestamp of the assistant message. */
  timestamp: string;
  model: string;
  provider: string;
  status: RequestStatus;
  /** Token counts from the assistant message usage block. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** USD cost computed from our pricing catalog. */
  inputCost: number;
  outputCost: number;
  totalCost: number;
  /** HTTP status from after_provider_response (if captured). */
  httpStatus: number | null;
}

export interface RateLimitSnapshot {
  /** Last observed HTTP status (429/529/etc). */
  lastStatus: number | null;
  /** Raw Retry-After header value, when present. */
  retryAfter: string | null;
  /** Parsed retry_after_seconds from a 429 body, when present. */
  retryAfterSeconds: number | null;
  /** Parsed max_rpm from an abuse-throttle 429 body. */
  maxRpm: number | null;
  /** Whether the last 429 was likely an abuse/capacity throttle vs plan limit. */
  wasAbuseThrottle: boolean;
  /** Timestamp (epoch ms) of the last rate-limit event. */
  updatedAt: number | null;
}

export interface UsageSnapshot {
  totals: {
    requests: number;
    billableRequests: number; // success + client_error only
    success: number;
    clientErrors: number;
    upstreamErrors: number;
    rateLimited: number;
    aborted: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    inputCost: number;
    outputCost: number;
    totalCost: number;
  };
  /** Requests counted in the current 5h rolling window (billable only). */
  windowRequests: number;
  /** Requests counted in the current 60s burst window (billable only). */
  burstRequests: number;
  rateLimit: RateLimitSnapshot;
  byModel: Record<string, {
    requests: number;
    billableRequests: number;
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
  }>;
  recent: UsageRecord[];
}

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours (plan quota window)
const BURST_MS = 60 * 1000; // 60 seconds (per-minute burst limit)

export class UsageLedger {
  private records: UsageRecord[] = [];
  private rateLimit: RateLimitSnapshot = {
    lastStatus: null,
    retryAfter: null,
    retryAfterSeconds: null,
    maxRpm: null,
    wasAbuseThrottle: false,
    updatedAt: null,
  };

  recordUsage(rec: UsageRecord): void {
    this.records.push(rec);
    // Keep the ledger bounded; the full history lives in the session transcript.
    if (this.records.length > 500) this.records.shift();
  }

  recordRateLimit(
    status: number,
    headers: Record<string, string>,
    body: { retry_after_seconds?: number; max_rpm?: number; error?: string } | null,
  ): void {
    const retryAfter = headers["retry-after"] ?? headers["Retry-After"] ?? null;
    const retryAfterSeconds = body?.retry_after_seconds ?? null;
    const maxRpm = body?.max_rpm ?? null;
    const errorMsg = body?.error ?? "";
    // Abuse/capacity throttle bodies mention "lower rate" / "max_rpm".
    const wasAbuseThrottle =
      maxRpm != null || /lower rate|temporary rate limit|high load/i.test(errorMsg);

    this.rateLimit = {
      lastStatus: status,
      retryAfter,
      retryAfterSeconds,
      maxRpm,
      wasAbuseThrottle,
      updatedAt: Date.now(),
    };
  }

  /** Record an HTTP status from after_provider_response, without a full usage block. */
  recordStatus(status: number, headers: Record<string, string>): void {
    if (status === 429 || status === 529) {
      this.recordRateLimit(status, headers, null);
    }
  }

  snapshot(): UsageSnapshot {
    const now = Date.now();
    const windowCutoff = now - WINDOW_MS;
    const burstCutoff = now - BURST_MS;

    const totals = {
      requests: 0,
      billableRequests: 0,
      success: 0,
      clientErrors: 0,
      upstreamErrors: 0,
      rateLimited: 0,
      aborted: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
    };
    const byModel: UsageSnapshot["byModel"] = {};
    let windowRequests = 0;
    let burstRequests = 0;

    for (const rec of this.records) {
      totals.requests++;
      const isBillable = rec.status === "success" || rec.status === "client_error";
      if (isBillable) totals.billableRequests++;
      if (rec.status === "success") totals.success++;
      else if (rec.status === "client_error") totals.clientErrors++;
      else if (rec.status === "upstream_error") totals.upstreamErrors++;
      else if (rec.status === "rate_limited") totals.rateLimited++;
      else if (rec.status === "aborted") totals.aborted++;

      totals.inputTokens += rec.inputTokens;
      totals.outputTokens += rec.outputTokens;
      totals.cacheReadTokens += rec.cacheReadTokens;
      totals.cacheWriteTokens += rec.cacheWriteTokens;
      totals.totalTokens += rec.totalTokens;
      totals.inputCost += rec.inputCost;
      totals.outputCost += rec.outputCost;
      totals.totalCost += rec.totalCost;

      const ts = Date.parse(rec.timestamp);
      if (isBillable && Number.isFinite(ts)) {
        if (ts >= windowCutoff) windowRequests++;
        if (ts >= burstCutoff) burstRequests++;
      }

      const key = rec.model || "(unknown)";
      const entry = (byModel[key] ??= {
        requests: 0,
        billableRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
      });
      entry.requests++;
      if (isBillable) entry.billableRequests++;
      entry.inputTokens += rec.inputTokens;
      entry.outputTokens += rec.outputTokens;
      entry.totalCost += rec.totalCost;
    }

    return {
      totals,
      windowRequests,
      burstRequests,
      rateLimit: { ...this.rateLimit },
      byModel,
      recent: this.records.slice(-15).reverse(),
    };
  }

  reset(): void {
    this.records = [];
    this.rateLimit = {
      lastStatus: null,
      retryAfter: null,
      retryAfterSeconds: null,
      maxRpm: null,
      wasAbuseThrottle: false,
      updatedAt: null,
    };
  }
}

/** Convert USD-per-1M rates into a per-call cost. */
export function computeCost(
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
  rates: { input: number; output: number; cacheRead: number; cacheWrite: number },
): { inputCost: number; outputCost: number; totalCost: number } {
  const inputCost = (tokens.input * rates.input) / 1_000_000;
  const outputCost = (tokens.output * rates.output) / 1_000_000;
  const cacheReadCost = (tokens.cacheRead * rates.cacheRead) / 1_000_000;
  const cacheWriteCost = (tokens.cacheWrite * rates.cacheWrite) / 1_000_000;
  return {
    inputCost: inputCost + cacheReadCost,
    outputCost,
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
  };
}
