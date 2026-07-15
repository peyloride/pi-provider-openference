/**
 * Tests for the retryable-error classifier in index.ts.
 *
 * Runs with Node's built-in test runner: `node --test` (no test framework dep).
 * Imports only the pure helpers (retryableErrorFor / rewriteForRetry) — no pi
 * runtime, no network, no auth.json. The message_end wiring is intentionally
 * thin (it just calls rewriteForRetry), so testing the pure function covers the
 * entire decision surface.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RETRYABLE_ERRORS,
  STREAM_RETRYABLE_ERRORS,
  RETRYABLE_PREFIX,
  retryableErrorFor,
  rewriteForRetry,
  isRetryableStreamError,
  type RetryableProbeMessage,
} from "../index.ts";

/** Minimal assistant error fixture; overrides win. */
function msg(overrides: Partial<RetryableProbeMessage> = {}): RetryableProbeMessage {
  return {
    role: "assistant",
    stopReason: "error",
    provider: "openference",
    errorMessage: '400: {"message":"The request could not be processed. Check your model, messages, and parameters.","type":"invalid_request_error","code":"invalid_request_error","param":null}',
    ...overrides,
  };
}

test("RETRYABLE_ERRORS ships the intermittent 400 entry", () => {
  assert.equal(RETRYABLE_ERRORS.length, 1, "expected exactly one entry by default");
  const [entry] = RETRYABLE_ERRORS;
  assert.equal(entry.label, "intermittent invalid_request_error (400)");
  assert.ok(entry.pattern instanceof RegExp);
});

// --- scope guards -----------------------------------------------------------

test("non-assistant message is not retried", () => {
  assert.equal(retryableErrorFor(msg({ role: "user" })), null);
  assert.equal(retryableErrorFor(msg({ role: "toolResult" })), null);
  assert.equal(retryableErrorFor(msg({ role: "custom" })), null);
});

test("assistant stopReason !== 'error' is not retried", () => {
  for (const stopReason of ["stop", "length", "toolUse", "aborted"] as const) {
    assert.equal(retryableErrorFor(msg({ stopReason })), null);
  }
});

test("non-openference providers are not retried", () => {
  assert.equal(retryableErrorFor(msg({ provider: "anthropic" })), null);
  assert.equal(retryableErrorFor(msg({ provider: "openai" })), null);
  assert.equal(retryableErrorFor(msg({ provider: undefined })), null);
});

test("provider can come from ctx.model.provider when message lacks it", () => {
  // message has no provider field, but the active model is openference → retry.
  const m = msg({ provider: undefined });
  assert.ok(retryableErrorFor(m, "openference") !== null);
  // and a non-openference model → no retry even if message provider is missing.
  assert.equal(retryableErrorFor(m, "umans"), null);
});

test("provider from message OR model triggers a match (|| semantics)", () => {
  assert.ok(retryableErrorFor(msg({ provider: "openference" }), "umans") !== null);
  assert.ok(retryableErrorFor(msg({ provider: "umans" }), "openference") !== null);
});

// --- intermittent 400 entry -------------------------------------------------

test("matches the real Openference intermittent 400 error", () => {
  const match = retryableErrorFor(msg());
  assert.ok(match, "expected a match for the canonical intermittent 400");
  assert.equal(match, RETRYABLE_ERRORS[0], "must return the actual list entry, not a copy");
});

test("matches by the 'invalid_request_error' code token", () => {
  assert.ok(retryableErrorFor(msg({ errorMessage: '400: {"type":"invalid_request_error"}' })));
});

test("matches by the 'The request could not be processed' wording", () => {
  assert.ok(
    retryableErrorFor(msg({ errorMessage: '400: {"message":"The request could not be processed."}' })));
});

test("does NOT retry a bare 400 without the invalid_request_error signature", () => {
  // A deterministic 400 (unknown model, malformed params) carries a body that
  // lacks our specific token — it must NOT be retried.
  assert.equal(retryableErrorFor(msg({ errorMessage: '400: {"message":"model not found"}' })), null);
  assert.equal(retryableErrorFor(msg({ errorMessage: '400: bad request' })), null);
  assert.equal(retryableErrorFor(msg({ errorMessage: "Bad Request" })), null);
});

// --- terminal guard (defense in depth) -------------------------------------

test("terminal signals are never retried even alongside a retryable signature", () => {
  // If a future broad entry ever matched a quota/billing/overflow message, the
  // TERMINAL_ERROR guard must still veto it.
  const terminalBodies = [
    "insufficient_quota: you exceeded your current quota",
    "out of budget for this org",
    "quota exceeded — upgrade your plan",
    "billing issue: card declined",
    "context_length_exceeded: input too long",
    '400: {"message":"The request could not be processed.","code":"invalid_request_error"} — insufficient_quota',
  ];
  for (const body of terminalBodies) {
    assert.equal(retryableErrorFor(msg({ errorMessage: body })), null, `body: ${body}`);
  }
});

test("empty / missing errorMessage is not retried", () => {
  assert.equal(retryableErrorFor(msg({ errorMessage: "" })), null);
  assert.equal(retryableErrorFor(msg({ errorMessage: undefined })), null);
});

// --- idempotency -----------------------------------------------------------

test("an already-rewritten errorMessage is not rewritten again", () => {
  const once = rewriteForRetry(msg())!;
  assert.ok(once.startsWith(RETRYABLE_PREFIX));
  // Re-classifying the rewritten message must yield null (no double-wrap).
  assert.equal(retryableErrorFor(msg({ errorMessage: once })), null);
  assert.equal(rewriteForRetry(msg({ errorMessage: once })), null);
});

// --- rewrite output shape --------------------------------------------------

test("rewriteForRetry formats the classified message for pi's classifier", () => {
  const original = msg().errorMessage!;
  const rewrite = rewriteForRetry(msg());
  assert.ok(rewrite, "expected a non-null rewrite for a retryable message");
  assert.ok(rewrite!.startsWith(`${RETRYABLE_PREFIX}: `), "must start with the retryable prefix");
  assert.ok(rewrite!.includes("(treated as transient)"), "must mark the message as transient");
  assert.ok(rewrite!.includes("Original:"), "must include the original error for logs");
  assert.ok(rewrite!.endsWith(original), "must end with the verbatim original errorMessage");
});

test("rewriteForRetry returns null for non-retryable messages", () => {
  assert.equal(rewriteForRetry(msg({ provider: "anthropic" })), null);
  assert.equal(rewriteForRetry(msg({ stopReason: "stop" })), null);
  assert.equal(rewriteForRetry(msg({ errorMessage: '400: {"message":"model not found"}' })), null);
  assert.equal(rewriteForRetry(msg({ errorMessage: "insufficient_quota" })), null);
});

// --- no shadowing of pi-native retryable classes ---------------------------

test("native-pi retryable errors (429/5xx/overloaded/network) are left to pi's message_end layer", () => {
  // These are already retried by pi's own classifier. The message_end backstop
  // must be a no-op for them (return null) so it never conflicts or double-tags.
  // Note: 5xx ARE retried by the in-stream layer (isRetryableStreamError),
  // but NOT rewritten by the message_end backstop (retryableErrorFor) —
  // tested separately below.
  const nativeRetryable = [
    '429: {"message":"Too many requests"}',
    '503: {"message":"Service unavailable"}',
    "overloaded: the server is overloaded",
    "rate limit exceeded",
    "fetch failed: ECONNRESET",
    "socket hang up",
    "stream ended without finish_reason",
    "network_error",
  ];
  for (const body of nativeRetryable) {
    assert.equal(retryableErrorFor(msg({ errorMessage: body })), null, `body: ${body}`);
  }
});

// --- in-stream layer: 5xx handled silently, message_end backstop skips them --

test("isRetryableStreamError retries 5xx (in-stream only)", () => {
  const fiveXX = [
    '502: data: {"error":{"type":"server_error"}}\n\ndata: [DONE]',
    '500: internal server error',
    '503: service unavailable',
    '504: gateway timeout',
    '524: cloudflare timeout',
  ];
  for (const body of fiveXX) {
    assert.equal(isRetryableStreamError(body), true, `body: ${body}`);
  }
});

test("message_end backstop does NOT rewrite 5xx (left to pi native)", () => {
  // 5xx is in STREAM_RETRYABLE_ERRORS (in-stream) but NOT in RETRYABLE_ERRORS
  // (message_end). This keeps the final error message clean and avoids
  // redundantly rewriting something pi already retries.
  const fiveXX = [
    '502: data: {"error":{"type":"server_error"}}\n\ndata: [DONE]',
    '500: internal server error',
    '503: service unavailable',
  ];
  for (const body of fiveXX) {
    assert.equal(retryableErrorFor(msg({ errorMessage: body })), null, `body: ${body}`);
    assert.equal(rewriteForRetry(msg({ errorMessage: body })), null, `body: ${body}`);
  }
});

test("isRetryableStreamError does NOT retry terminal 5xx (billing/quota on a 503)", () => {
  assert.equal(isRetryableStreamError('503: billing issue'), false);
  assert.equal(isRetryableStreamError('503: quota exceeded'), false);
});

test("isRetryableStreamError still retries the intermittent 400 (shared list)", () => {
  const body = '400: {"type":"invalid_request_error","message":"The request could not be processed"}';
  assert.equal(isRetryableStreamError(body), true);
});

test("STREAM_RETRYABLE_ERRORS ships the 5xx entry", () => {
  assert.equal(STREAM_RETRYABLE_ERRORS.length, 1);
  assert.match(STREAM_RETRYABLE_ERRORS[0].label, /5xx/);
});
