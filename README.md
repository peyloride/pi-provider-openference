# pi-provider-openference

> ⚠️ **Vibe-coded.** This provider was written with AI assistance and no formal
> review; treat it accordingly. That said, I run it myself as a daily driver, so
> breakage tends to get noticed and fixed fast. Bug reports welcome.

Openference provider for [pi](https://pi.dev). Registers the models, handles
`/login`, and adds auto-retry for Openference's intermittent provider errors
(the transient 400s that succeed on the next attempt).

Openference is a curated OpenAI-compatible proxy at `https://api.openference.com/v1`.
One API key gets you models from GLM, DeepSeek, Qwen, Kimi, and others through
a single endpoint.

## Install

```bash
pi install npm:pi-provider-openference
```

Or from git:

```bash
pi install git:github.com/peyloride/pi-provider-openference
```

Then restart pi.

## Setup

After installing:

```bash
/login openference
/model openference/GLM-5.2
```

The key is stored in `~/.pi/agent/auth.json`. No env var needed. If you'd
rather use one, `OPENFERENCE_API_KEY` works as a fallback.

Bare `/login` (without the provider name) puts Openference under "Use a
subscription." That's just pi's label for the oauth login path; the key is a
plain API key. Easier to skip the menu and run `/login openference` directly.

Models are fetched live from `GET /v1/models` at load time. Change the key's
model restrictions in the dashboard later and run `/reload` to re-fetch.

## Files

- `index.ts` - provider registration and `/login` flow
- `models.ts` - model discovery and pricing
- `auth.ts` - reads the stored credential at startup
- `retry.ts` - shared allowlist + classifier for retryable provider errors
- `retry-stream.ts` - bounded in-stream retry wrapper (primary resilience layer)

## Resilience

Openference occasionally surfaces a transient `400 invalid_request_error` for a
request that succeeds on retry. pi does not retry 4xx by default (correctly,
since they're normally deterministic), so this package adds two cooperating
layers that read one shared allowlist (`retry.ts`):

1. In-stream retry (`retry-stream.ts`), the primary layer. It wraps the
   provider's stream function and retries a failed attempt before any content
   token reaches the consumer, so pi's turn loop never sees the hiccup. Scoped
   to Openference via a provider-private api id; the global `openai-completions`
   handler (used by openai, xai, grok, and the rest) is untouched.
2. `message_end` normalizer (`index.ts`), the backstop. If every in-stream
   attempt also fails, it rewrites the finalized error so pi's own turn-level
   retry fires.

Budget: 5 attempts, 1000ms base, exponential backoff capped at 8000ms.

## Adding retryable errors

The retryable error classes live in a single editable allowlist in
[`retry.ts`](./retry.ts), the `RETRYABLE_ERRORS` array. Both retry layers read
it, so adding an entry makes it retryable everywhere and deleting one removes
it. No other code changes are needed.

pi already retries 429, 5xx, overloaded, network, and timeout errors itself, so
don't add those. They're redundant, and an over-broad pattern risks retrying
genuinely broken requests. The allowlist is for errors pi does not retry by
default.

To add one, append an entry with a human-readable `label` and a `pattern`
(a RegExp matched case-insensitively against the full `errorMessage`):

```ts
export const RETRYABLE_ERRORS: RetryableError[] = [
  {
    label: "intermittent invalid_request_error (400)",
    pattern: /400[^\n]*(invalid_request_error|the request could not be processed)/i,
  },
  // Your new entry:
  {
    label: "describe the transient error",
    pattern: /<regex matched against the full errorMessage>/i,
  },
];
```

A few notes on writing a good pattern:

- Be specific. Match the HTTP status plus a distinctive token the error carries
  (an error code, or specific wording), never bare `"400"`. Otherwise
  deterministic client errors like a bad model name or a malformed request get
  retried for nothing.
- Match the formatted message, not raw JSON. pi surfaces provider errors as
  `"<status>: <json-body-stringified>"` (for example `400: {"message":"...",
  "type":"invalid_request_error"}`), so the status, error code, and wording all
  land on the same line.
- Keep it single-line. `[^\n]*` lets the regex span from the status to the
  wording without matching across unrelated log lines.
- Terminal errors are already excluded. Quota, billing, and
  `context_length_exceeded` are never retried regardless of the allowlist, so
  you can't accidentally shadow pi's own terminal or compaction paths.

Run `npm test` after editing. The suite covers the classifier, so a regression
in the pattern will show up. Then commit, push, and (if cutting a release) the
publish workflow runs the tests before shipping.

## References

- Pi guide: https://openference.com/docs/pi
- API reference: https://docs.openference.com/api-reference
- Models: https://openference.com/models
