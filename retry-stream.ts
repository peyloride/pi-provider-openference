/**
 * In-stream retry wrapper (primary resilience layer).
 *
 * Wraps the provider's `streamSimple` so a failed HTTP attempt is retried
 * *before* any content reaches the consumer — transparent to pi's turn loop.
 * Backstop is the message_end normalizer in retry.ts, which only fires if
 * every attempt here also fails.
 *
 * Scoped to Openference by construction: index.ts registers this wrapper
 * under a provider-private api id ("openference-completions"), so only
 * Openference models ever route through it. The global openai-completions
 * handler is untouched.
 */

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type Usage,
} from "@earendil-works/pi-ai";
import { isRetryableStreamError } from "./retry.ts";

/**
 * Total attempts (initial try + retries) before giving up and surfacing the
 * error to pi's turn loop (where the message_end normalizer may retry again).
 *
 * Tighter than pi's turn-level budget on purpose: this layer runs while the
 * user is waiting for the *first* token of a live stream, so latency matters
 * more than for a whole-turn retry.
 */
export const MAX_ATTEMPTS = 12;

/** Base backoff delay (ms) for the first retry; doubles each attempt. */
export const BASE_DELAY_MS = 1000;

/**
 * Per-attempt backoff cap (ms). Without it the exponential series reaches
 * impractically long single sleeps; capping keeps the worst-case stall bounded.
 */
export const MAX_DELAY_MS = 30000;

/** The underlying stream function this wrapper retries around. */
export type BaseStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface RetryStreamOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable sleep (for tests). Default: abortable exponential backoff. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

type TerminalReason = Extract<StopReason, "error" | "aborted">;

/**
 * A "content" event is any non-`start`, non-terminal event. Once the base
 * stream emits one, the wrapper is *committed* to this attempt: subsequent
 * events (including a mid-stream `error`) are piped straight through and the
 * attempt is never retried — retrying after content has started would emit
 * duplicated/garbled tokens to the consumer.
 */
export function isContentEvent(e: AssistantMessageEvent): boolean {
  return e.type !== "start" && e.type !== "done" && e.type !== "error";
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Build a terminal `error` event for cases where the base stream either threw
 * synchronously or ended without emitting a terminal (both unreachable for the
 * real openai-completions stream — it always pushes done/error — but handled
 * defensively and exercised by tests with fake streams).
 */
function syntheticErrorEvent(
  model: Model<Api>,
  errorMessage: string,
  reason: TerminalReason,
): AssistantMessageEvent {
  return {
    type: "error",
    reason,
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason: reason,
      errorMessage,
      timestamp: Date.now(),
    },
  };
}

/** Default abortable sleep used between retry attempts. Rejects on abort. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wrap a base `streamSimple` with a bounded retry loop.
 *
 * Retry policy:
 *   - Phase A (before any content token): buffer events; if the attempt ends
 *     with a retryable `error` (see isRetryableStreamError), back off + retry.
 *   - Phase B (after the first content token): pipe everything through, no
 *     retry — a partial response is already committed to the consumer.
 *   - Aborts (options.signal) are never retried; surfaced as stopReason
 *     "aborted" immediately (including abort during backoff sleep).
 *   - Budget: up to `maxAttempts` total tries; exponential backoff
 *     (baseDelayMs * 2^(attempt-2), capped at maxDelayMs) between attempts.
 */
export function createRetryStream(baseStream: BaseStreamFn, opts: RetryStreamOptions = {}): BaseStreamFn {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? MAX_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;

  function backoffDelay(attempt: number): number {
    // `attempt` is the just-failed attempt number (1-indexed); this sleep
    // precedes attempt+1, so the exponent is attempt-1: base, 2*base, 4*base, …
    const raw = baseDelayMs * 2 ** (attempt - 1);
    return Math.min(raw, maxDelayMs);
  }

  return function streamWithRetry(model, context, options) {
    const out = createAssistantMessageEventStream();
    const signal = options?.signal;

    (async () => {
      let attempt = 0;

      while (true) {
        attempt++;
        let committed = false;
        const buffered: AssistantMessageEvent[] = [];
        let terminal: AssistantMessageEvent | null = null;

        try {
          for await (const ev of baseStream(model, context, options)) {
            if (committed) {
              // Phase B: passthrough everything (including a terminal).
              out.push(ev);
              if (ev.type === "done" || ev.type === "error") return;
              continue;
            }
            if (isContentEvent(ev)) {
              // First content token → commit. Flush buffered pre-content
              // events (the `start`), then this event, then passthrough.
              committed = true;
              for (const b of buffered) out.push(b);
              buffered.length = 0;
              out.push(ev);
              continue;
            }
            if (ev.type === "done" || ev.type === "error") {
              terminal = ev;
              break;
            }
            // Pre-content, non-terminal (just `start`): buffer for later flush.
            buffered.push(ev);
          }
        } catch (err) {
          // Defensive: the real base stream always emits a terminal, not throws.
          const aborted = signal?.aborted === true;
          terminal = syntheticErrorEvent(
            model,
            err instanceof Error ? err.message : String(err),
            aborted ? "aborted" : "error",
          );
        }

        if (!terminal) {
          // Stream ended with neither content nor a terminal — abnormal.
          terminal = syntheticErrorEvent(
            model,
            "Stream ended without a terminal event",
            "error",
          );
        }

        if (terminal.type === "done") {
          for (const b of buffered) out.push(b);
          out.push(terminal);
          return;
        }

        // Unreachable in practice (terminal is always done/error), but guards
        // the narrowed error handling below against any future event variant.
        if (terminal.type !== "error") {
          for (const b of buffered) out.push(b);
          out.end();
          return;
        }

        // terminal.type === "error" — decide whether to retry.
        const prevError: AssistantMessage = terminal.error;
        const errMsg = prevError.errorMessage ?? "";
        const aborted = terminal.reason === "aborted" || signal?.aborted === true;
        const retryable = !aborted && attempt < maxAttempts && isRetryableStreamError(errMsg);

        if (!retryable) {
          for (const b of buffered) out.push(b);
          out.push(terminal);
          return;
        }

        // Retry after backoff. Honor abort during the sleep.
        try {
          await sleep(backoffDelay(attempt), signal);
        } catch {
          for (const b of buffered) out.push(b);
          out.push({
            type: "error",
            reason: "aborted",
            error: {
              ...prevError,
              stopReason: "aborted",
              errorMessage: "Request was aborted during retry backoff",
            },
          });
          return;
        }
        // loop → next attempt
      }
    })().catch((err) => {
      // Unexpected driver throw → surface as a terminal error (keeps result()
      // from hanging). Uses the real model in scope.
      out.push(
        syntheticErrorEvent(
          model,
          err instanceof Error ? err.message : String(err),
          "error",
        ),
      );
    });

    return out;
  };
}
