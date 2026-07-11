# pi-provider-openference

Openference provider for [pi](https://pi.dev). Registers the models and
handles `/login`. That's it.

Openference is a curated OpenAI-compatible proxy at `https://api.openference.com/v1`.
One API key gets you models from GLM, DeepSeek, Qwen, Kimi, Mistral, and others
through a single endpoint.

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

## References

- Pi guide: https://openference.com/docs/pi
- API reference: https://docs.openference.com/api-reference
- Models: https://openference.com/models
