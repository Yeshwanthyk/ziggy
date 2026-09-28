---
name: web-search
description: Search the web for fresh facts through Exa when local information cannot answer the request.
---

# Web Search

Use `web_search` with query words in `args`:

```json
{"args":["best time to visit the science museum this weekend"]}
{"args":["hardware store opening hours","--n","3"]}
```

The result is:

```json
{"query":"...","answer":"...","results":[{"title":"...","url":"...","highlight":"..."}]}
```

Read the structured `results`; each `highlight` is the relevant excerpt. Cite
one or two result URLs. `answer` is populated only when the endpoint response
cannot be structured. No API key is required; `EXA_API_KEY` only raises service
limits.

Use this only for information that benefits from a current external search.
