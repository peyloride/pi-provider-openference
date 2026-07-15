/**
 * Tests for the in-stream retry wrapper (retry-stream.ts).
 *
 * Runs with Node's built-in test runner: `node --test` (no framework dep).
 * The wrapper takes an injectable `baseStream` (so we script provider
 * responses) and an injectable `sleep` (so backoff is instant + recorded).
 * No pi runtime, no network, no auth.json.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  createRetryStream,
  isContentEvent,
  type BaseStreamFn,
} from "../retry-stream.ts";

// --- fixtures --------------------------------------------------------------

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The real formatted Openference intermittent-400 error (status + JSON body). */
const RETRYABLE_MSG =
  '400: {"message":"The request could not be processed. Check your model, messages, and parameters.","type":"invalid_request_error","code":"invalid_request_error","param":null}';

function partial(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openference-completions" as Api,
    provider: "openference",
    model: "GLM-5.2",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: 0,
  };
}

const start = (): AssistantMessageEvent => ({ type: "start", partial: partial() });
const text = (delta: string): AssistantMessageEvent => ({
  type: "text_delta",
  contentIndex: 0,
  delta,
  partial: partial(),
});
const done = (): AssistantMessageEvent => ({ type: "done", reason: "stop", message: partial() });
const error = (
  errorMessage: string,
  reason: "error" | "aborted" = "error",
): AssistantMessageEvent => ({
  type: "error",
  reason,
  error: { ...partial(), stopReason: reason, errorMessage },
});

/** Minimal model/context fixtures — the wrapper + fake only read id/api/provider. */
const MODEL = { id: "GLM-5.2", api: "openference-completions", provider: "openference" } as unknown as Model<Api>;
const CONTEXT = {} as unknown as Context;

/** Fake base stream that emits a scripted list of events then completes.
 * The `end()` is essential: without it, the wrapper's `for await` over the
 * returned stream would await the next event forever (the real openai-completions
 * stream always pushes a `done`/`error` terminal, which marks it complete). */
function scriptedBaseStream(attempts: AssistantMessageEvent[][]): BaseStreamFn {
  let i = 0;
  return () => {
    const events = attempts[i++] ?? [];
    const s = createAssistantMessageEventStream();
    for (const e of events) s.push(e);
    s.end();
    return s;
  };
}

/** Injectable sleep: records delays + resolves instantly. */
function recordingSleep(log: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    log.push(ms);
  };
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const out: AssistantMessageEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const types = (events: AssistantMessageEvent[]) => events.map((e) => e.type);

/** Build a wrapper around `base` with fast/injectable sleep + recorded delays. */
function wrapWith(
  base: BaseStreamFn,
  sleeps: number[],
  opts: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
) {
  return createRetryStream(base, {
    maxAttempts: opts.maxAttempts,
    baseDelayMs: opts.baseDelayMs,
    maxDelayMs: opts.maxDelayMs,
    sleep: recordingSleep(sleeps),
  });
}

// --- isContentEvent --------------------------------------------------------

test("isContentEvent: only start/done/error are non-content", () => {
  assert.equal(isContentEvent(start()), false);
  assert.equal(isContentEvent({ type: "text_start", contentIndex: 0, partial: partial() }), true);
  assert.equal(isContentEvent(text("x")), true);
  assert.equal(isContentEvent({ type: "text_end", contentIndex: 0, content: "x", partial: partial() }), true);
  assert.equal(isContentEvent({ type: "thinking_start", contentIndex: 0, partial: partial() }), true);
  assert.equal(isContentEvent({ type: "toolcall_start", contentIndex: 0, partial: partial() }), true);
  assert.equal(isContentEvent(done()), false);
  assert.equal(isContentEvent(error("x")), false);
});

// --- happy path ------------------------------------------------------------

test("success on first attempt: pipes through, no retry, no sleep", async () => {
  const base = scriptedBaseStream([[start(), text("hi"), done()]]);
  const sleeps: number[] = [];
  const wrap = wrapWith(base, sleeps);
  const stream = wrap(MODEL, CONTEXT);
  const events = await collect(stream);
  assert.deepEqual(types(events), ["start", "text_delta", "done"]);
  assert.deepEqual(sleeps, []);
  const result = await stream.result();
  assert.equal(result.stopReason, "stop");
});

// --- retry then success ----------------------------------------------------

test("retryable pre-content error is retried, then succeeds", async () => {
  const base = scriptedBaseStream([
    [start(), error(RETRYABLE_MSG)], // attempt 1: transient 400
    [start(), text("ok"), done()], // attempt 2: success
  ]);
  const sleeps: number[] = [];
  const wrap = wrapWith(base, sleeps, { maxAttempts: 5, baseDelayMs: 1000 });
  const events = await collect(wrap(MODEL, CONTEXT));
  // The failed attempt's `start` is buffered+discarded (no partial output leaks).
  assert.deepEqual(types(events), ["start", "text_delta", "done"]);
  assert.deepEqual(sleeps, [1000]); // one backoff before attempt 2
});

test("the failed attempt's buffered `start` is NOT emitted to the consumer", async () => {
  // Two `start`s would reach the consumer if buffering didn't discard on retry.
  const base = scriptedBaseStream([[start(), error(RETRYABLE_MSG)], [start(), text("ok"), done()]]);
  const events = await collect(wrapWith(base, [], { maxAttempts: 5, baseDelayMs: 1 })(MODEL, CONTEXT));
  assert.equal(events.filter((e) => e.type === "start").length, 1);
});

// --- no-retry paths --------------------------------------------------------

test("non-retryable HTTP error (404) is passed through, no retry", async () => {
  const base = scriptedBaseStream([[start(), error("404: model not found")]]);
  const sleeps: number[] = [];
  const events = await collect(wrapWith(base, sleeps)(MODEL, CONTEXT));
  assert.deepEqual(types(events), ["start", "error"]);
  assert.deepEqual(sleeps, []);
  assert.equal(events[events.length - 1].type, "error");
});

test("5xx errors (including 502 with ugly SSE body) are retried in-stream", async () => {
  // This is the real Openference 502: the provider's streaming endpoint
  // returns errors as SSE, so the body carries `data: {...}` and `data: [DONE]`.
  // The wrapper retries it silently and the user never sees the raw text.
  const ugly502 =
    '502: data: {"error":{"message":"The model provider is temporarily unavailable. Please try again in a moment.","type":"server_error"}}\n\ndata: [DONE]';
  const base = scriptedBaseStream([
    [start(), error(ugly502)], // attempt 1: 502
    [start(), text("ok"), done()], // attempt 2: success
  ]);
  const sleeps: number[] = [];
  const events = await collect(wrapWith(base, sleeps, { maxAttempts: 5, baseDelayMs: 1000 })(MODEL, CONTEXT));
  assert.deepEqual(types(events), ["start", "text_delta", "done"]);
  assert.deepEqual(sleeps, [1000]);
});

test("5xx with a terminal signal (503 billing) is NOT retried", async () => {
  const base = scriptedBaseStream([[start(), error("503: billing issue, upgrade required")]]);
  const sleeps: number[] = [];
  const events = await collect(wrapWith(base, sleeps)(MODEL, CONTEXT));
  assert.deepEqual(types(events), ["start", "error"]);
  assert.deepEqual(sleeps, []);
});

test("terminal errors (context_length_exceeded) are never retried", async () => {
  const base = scriptedBaseStream([[start(), error("context_length_exceeded: too long")]]);
  const sleeps: number[] = [];
  const events = await collect(wrapWith(base, sleeps)(MODEL, CONTEXT));
  assert.deepEqual(types(events), ["start", "error"]);
  assert.deepEqual(sleeps, []);
});

test("error AFTER content (Phase B) is not retried even when retryable", async () => {
  // The 400 here is retryable by signature, but it arrives mid-stream — the
  // wrapper is committed and must pipe it through (can't unstream tokens).
  const base = scriptedBaseStream([[start(), text("partial"), error(RETRYABLE_MSG)]]);
  const sleeps: number[] = [];
  const events = await collect(wrapWith(base, sleeps)(MODEL, CONTEXT));
  assert.deepEqual(types(events), ["start", "text_delta", "error"]);
  assert.deepEqual(sleeps, []);
});

// --- budget ---------------------------------------------------------------

test("exhausts retries then surfaces the error; attempts == maxAttempts", async () => {
  const calls: number[] = [];
  const base: BaseStreamFn = () => {
    calls.push(1);
    const s = createAssistantMessageEventStream();
    s.push(start());
    s.push(error(RETRYABLE_MSG));
    return s;
  };
  const sleeps: number[] = [];
  const events = await collect(wrapWith(base, sleeps, { maxAttempts: 3, baseDelayMs: 1000 })(MODEL, CONTEXT));
  assert.equal(calls.length, 3); // 1 initial + 2 retries
  assert.deepEqual(types(events), ["start", "error"]);
  // 2 sleeps (after attempt 1 and 2): base*2^0, base*2^1
  assert.deepEqual(sleeps, [1000, 2000]);
  const last = events[events.length - 1];
  assert.equal(last.type, "error");
  if (last.type === "error") assert.equal(last.reason, "error");
});

test("backoff is capped at maxDelayMs", async () => {
  const base: BaseStreamFn = () => {
    const s = createAssistantMessageEventStream();
    s.push(start());
    s.push(error(RETRYABLE_MSG));
    return s;
  };
  const sleeps: number[] = [];
  await collect(wrapWith(base, sleeps, { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 2000 })(MODEL, CONTEXT));
  // attempts 1-4 fail and sleep; attempt 5 fails and gives up (5 < 5 is false).
  // delays: 1000*2^0=1000, 1000*2^1=2000(cap), 1000*2^2=4000->2000, 1000*2^3=8000->2000
  assert.deepEqual(sleeps, [1000, 2000, 2000, 2000]);
});

// --- abort ----------------------------------------------------------------

test("abort during backoff sleep surfaces as stopReason 'aborted'", async () => {
  const base = scriptedBaseStream([[start(), error(RETRYABLE_MSG)]]);
  const abortingSleep = async (): Promise<void> => {
    throw new Error("aborted"); // simulate abort mid-sleep
  };
  const wrap = createRetryStream(base, { sleep: abortingSleep });
  const events = await collect(wrap(MODEL, CONTEXT));
  assert.deepEqual(types(events), ["start", "error"]);
  const last = events[events.length - 1];
  if (last.type === "error") assert.equal(last.reason, "aborted");
});

test("an already-aborted signal is not retried (base reports aborted)", async () => {
  const ac = new AbortController();
  ac.abort();
  const base = scriptedBaseStream([[start(), error("aborted by signal", "aborted")]]);
  const sleeps: number[] = [];
  const wrap = wrapWith(base, sleeps);
  const events = await collect(wrap(MODEL, CONTEXT, { signal: ac.signal } as never));
  assert.deepEqual(types(events), ["start", "error"]);
  assert.deepEqual(sleeps, []);
  const last = events[events.length - 1];
  if (last.type === "error") assert.equal(last.reason, "aborted");
});

// --- defensive paths ------------------------------------------------------

test("a base stream that throws synchronously is surfaced as a terminal error", async () => {
  const base: BaseStreamFn = () => {
    throw new Error("No API key for provider: openference");
  };
  const sleeps: number[] = [];
  const events = await collect(wrapWith(base, sleeps)(MODEL, CONTEXT));
  // Not retryable (no 400 signature) → no sleep, single error.
  assert.deepEqual(types(events), ["error"]);
  assert.deepEqual(sleeps, []);
  const last = events[events.length - 1];
  if (last.type === "error") assert.match(last.error.errorMessage ?? "", /No API key/);
});

test("a base stream that ends with no terminal is surfaced as a terminal error", async () => {
  // Empty scripted response → base returns a stream with no events at all.
  const base = scriptedBaseStream([[]]);
  const events = await collect(wrapWith(base, [], {})(MODEL, CONTEXT));
  assert.deepEqual(types(events), ["error"]);
});
