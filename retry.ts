/**
 * Retryable-error classification (shared by both retry layers).
 *
 * Two layers cooperate to make Openference resilient to transient provider
 * errors:
 *
 *   1. In-stream retry (retry-stream.ts) — wraps the provider's streamSimple
 *      and retries a failed attempt *before* any content is emitted to the
 *      consumer. Primary mechanism; transparent to pi's turn loop.
 *   2. message_end normalizer (index.ts) — rewrites the finalized error
 *      message so pi's built-in turn-level retry fires. Backstop; only runs
 *      if every in-stream attempt also failed.
 *
 * Two allowlists feed these layers (see below):
 *   - RETRYABLE_ERRORS: errors pi does NOT retry on its own (e.g. intermittent
 *     400s). Both layers handle these — in-stream retries silently, and the
 *     message_end backstop rewrites the message so pi's turn retry fires.
 *   - STREAM_RETRYABLE_ERRORS: errors pi DOES retry at turn level (5xx), but
 *     that the in-stream layer also retries silently first so the raw server
 *     error text never reaches the user during retries. Only the in-stream
 *     layer reads this; the message_end backstop leaves these to pi's native
 *     handling (keeps the final error message cleaner).
 *
 * All helpers are pure (module-scope, no pi runtime) so they can be
 * unit-tested directly.
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
 * Both layers read this list: the in-stream wrapper retries them silently
 * before content, and the message_end backstop rewrites the finalized error
 * so pi's turn-level retry fires.
 *
 * Only put errors here that pi does NOT already retry. For errors pi DOES
 * retry (5xx, 429, network, timeout, etc.) that you also want retried
 * silently in-stream, use STREAM_RETRYABLE_ERRORS instead — that keeps the
 * message_end backstop from redundantly rewriting them (pi already handles
 * them at turn level) and keeps the final error message cleaner.
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
    //
    // The openai-completions base stream formats provider 400s as
    // `400: {"message":"The request could not be processed...","type":"invalid_request_error",...}`
    // (status + JSON-stringified body), so both alternatives appear on the same
    // line as the leading "400".
    label: "intermittent invalid_request_error (400)",
    pattern: /400[^\n]*(invalid_request_error|the request could not be processed)/i,
  },
  {
    // Openference's upstream provider can drop mid-stream, producing a truncated
    // JSON response that fails to parse. The OpenAI SDK throws a SyntaxError
    // with "Unterminated string in JSON" — this is transient (next attempt gets
    // a complete response). Not a 4xx/5xx, so pi's native retry ignores it.
    label: "truncated JSON response (unterminated string)",
    pattern: /unterminated string in json/i,
  },
  {
    // Openference's upstream can interrupt the SSE stream before the response
    // completes. The openai-completions streamer surfaces this as
    // "The model provider's stream was interrupted. Please retry."
    // Not a 4xx/5xx, so pi's native retry ignores it.
    label: "stream interrupted",
    pattern: /stream was interrupted/i,
  },
];

/**
 * Additional allowlist for errors pi DOES retry at turn level, but that the
 * in-stream layer also retries silently first.
 *
 * Why: pi retries 5xx natively, but it surfaces the raw server error text
 * (including ugly SSE framing like `data: {"error":...}` and `data: [DONE]`)
 * during those turn-level retries. Retrying here, before any content is
 * emitted, hides that text from the user entirely. The message_end backstop
 * does NOT read this list — it leaves 5xx to pi's own retry so the final
 * error (if every attempt fails) stays as the provider's original message,
 * not a double-wrapped rewrite.
 *
 * TO ADD OR REMOVE: append or delete an entry. Only the in-stream layer is
 * affected.
 */
export const STREAM_RETRYABLE_ERRORS: RetryableError[] = [
  {
    label: "server error (5xx)",
    // Matches any 3-digit 5xx HTTP status in the formatted errorMessage.
    // pi-ai formats provider errors as `<status>: <body>` (e.g.
    // `502: data: {"error":{"type":"server_error"}}\n\ndata: [DONE]`), so the
    // status code appears as a bare number with word boundaries. All 5xx are
    // server-side and safe to retry; TERMINAL_ERROR above catches the rare
    // non-retryable kind (e.g. a 503 carrying a billing message).
    pattern: /\b5\d{2}\b/,
  },
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
 * Checks BOTH allowlists (RETRYABLE_ERRORS + STREAM_RETRYABLE_ERRORS) because
 * the in-stream layer should silently retry everything transient, including
 * 5xx that pi also retries at turn level. Provider scoping is NOT checked
 * here — this classifier only runs inside the provider-scoped wrapper
 * (createRetryStream), which is registered under a provider-private api id, so
 * it can only ever be invoked for Openference models.
 */
export function isRetryableStreamError(errorMessage: string): boolean {
  if (!errorMessage) return false;
  if (errorMessage.startsWith(RETRYABLE_PREFIX)) return false; // already rewritten upstream — not a raw stream error
  if (TERMINAL_ERROR.test(errorMessage)) return false;
  return (
    RETRYABLE_ERRORS.some((e) => e.pattern.test(errorMessage)) ||
    STREAM_RETRYABLE_ERRORS.some((e) => e.pattern.test(errorMessage))
  );
}
