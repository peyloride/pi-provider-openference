# openference-usage

Openference provider for [pi](https://pi.dev). Registers the models, handles
`/login`, and tracks how many requests you've burned through against your
rolling quota.

Openference is a curated OpenAI-compatible proxy at `https://api.openference.com/v1`.
One API key, billed per request against a plan window (e.g. 1500 requests per 5
hours) plus a per-minute burst cap.

## Setup

Restart pi after installing, then:

```bash
/login openference        # paste your key, gets validated against GET /v1/models
/model openference/GLM-5.2
```

The key is stored in `~/.pi/agent/auth.json`. No env var needed. If you'd
rather use one, `OPENFERENCE_API_KEY` still works as a fallback.

Bare `/login` (without the provider name) puts Openference under "Use a
subscription." That's just pi's label for the oauth login path; the key is a
plain API key. Easier to skip the menu and run `/login openference` directly.

Change the key's model restrictions in the dashboard later? Run `/reload` to
re-fetch the list.

## Request usage tracking

Openference bills per request, not per token, for plan quota. Tokens drive
pay-as-you-go cost. This extension tracks both.

The ledger counts billable requests (success and 4xx count; 502/529 upstream
errors don't), keeps 5-hour window and 60-second burst tallies, breaks down
tokens and cost per model, and remembers the last 429 or 529 with its retry
hint. It rebuilds from the session transcript on startup, so it survives
`/reload` and `/resume`.

Three ways to check it:

- `/openference` command. Prints a summary and drops an expandable card into the transcript.
- `openference_usage` tool. Returns a JSON snapshot to the model.
- `openference_requests` tool. Returns recent request records, filterable by model or status.

The footer shows a live counter: `⚡OF 42 req · $1.30`.

## Files

- `index.ts` - provider registration, event hooks, tools, command
- `models.ts` - model discovery and pricing
- `usage.ts` - the ledger, status classification, cost math
- `render.ts` - footer and transcript card
- `auth.ts` - reads the stored credential at startup

## References

- Pi guide: https://openference.com/docs/pi
- API reference: https://docs.openference.com/api-reference
- Rate limits: https://docs.openference.com/api-reference/rate-limits
- Models: https://openference.com/models
