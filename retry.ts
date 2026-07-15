/**
 * Retryable-error classification (shared by both retry layers).
 *
 * Two layers cooperate to make Openference resilient to intermittent
 * provider errors that pi does not retry by default:
 *
 *   1. In-stream retry (retry-stream.ts) — wraps the provider's streamSimple
 *      and retries a failed attempt *before* any content is emitted to the
 *      consumer. Primary mechanism; transparent to pi's turn loop.
 *   2. message_end normalizer (index.ts) — rewrites the finalized error
 *      message so pi's built-in turn-level retry fires. Backstop; only runs
 *      if every in-stream attempt also failed.
 *
 * Both layers read the SAME allowlist below, so an error class is retryable
 * at one layer iff it is retryable at the other. All helpers are pure
 * (module-scope, no pi runtime) so they can be unit-tested directly.
 */

import { OPENFERENCE_PROVIDER } from "./models.ts";

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export interface RetryableError {
  /** Human-readable label; surfaced in the rewritten errorMessage for logs. */
  label: string;
  /** Tested (case-insensitive) against the full errorMessage. */
  pattern: RegExp;
}

/**
 * Allowlist of error classes pi does NOT retry by default.
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
 * other code changes needed — both layers read this array.
 */
export const RETRYABLE_ERRORS: RetryableError[] = [
  {
    // Openference occasionally 400s a request that succeeds on the next attempt.
    // Match the status + a distinctive token it carries (the error code OR its
    // specific wording), not bare "400", so deterministic client errors are
    // not retried. The phrase is matched unquoted so trailing punctuation inside
    // the JSON message value doesn't defeat the match.
    //
    // The openai-completions base stream formats provider 400s as
    // `400: {"message":"The request could not be processed...","type":"invalid_request_error",...}`
    // (status + JSON-stringified body), so both alternatives appear on the same
    // line as the leading "400".
    label: "intermittent invalid_request_error (400)",
    pattern: /400[^\n]*(invalid_request_error|the request could not be processed)/i,
  },
  // { label: "<describe the transient error>", pattern: /<regex>/i },
];

/** Prefix that makes pi's retry classifier treat the message as retryable. */
export const RETRYABLE_PREFIX = "provider returned error";

/** Terminal signals pi must NOT retry (own paths: terminal or compaction). */
export const TERMINAL_ERROR =
  /insufficient_quota|out of budget|quota exceeded|billing|context_length_exceeded/i;

// ---------------------------------------------------------------------------
// message_end layer (turn-level backstop)
// ---------------------------------------------------------------------------

/** Structural subset of a finalized message — enough to classify retryability. */
export interface RetryableProbeMessage {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
}

/**
 * Pure classifier (message_end layer): returns the matching RetryableError
 * entry for an Openference assistant error, or null when the message must NOT
 * be rewritten.
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
// in-stream layer
// ---------------------------------------------------------------------------

/**
 * Pure classifier (in-stream layer): should this stream `error` event's
 * errorMessage be retried with a fresh attempt?
 *
 * Shares the same allowlist + terminal guard as the message_end layer so the
 * two layers agree on what is retryable. Provider scoping is NOT checked here
 * — this classifier only runs inside the provider-scoped wrapper
 * (createRetryStream), which is registered under a provider-private api id, so
 * it can only ever be invoked for Openference models.
 */
export function isRetryableStreamError(errorMessage: string): boolean {
  if (!errorMessage) return false;
  if (errorMessage.startsWith(RETRYABLE_PREFIX)) return false; // already rewritten upstream — not a raw stream error
  if (TERMINAL_ERROR.test(errorMessage)) return false;
  return RETRYABLE_ERRORS.some((e) => e.pattern.test(errorMessage));
}
