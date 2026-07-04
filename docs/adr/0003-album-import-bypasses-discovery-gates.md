# Album import is a separate, ungated bulk path from discovery

There are now two ways an RSS feed enters the pipeline. **Discovery** is the
cron-driven firehose: it scans many sources incrementally, dedups, and applies
score gates (gate-1 prescore floor, gate-2 threshold → `screened`) so only
high-scoring novelties reach the daily stream. **Album import** is the opposite:
an editor has already decided a whole source is worth keeping, so a manual
"import" action enqueues **every** fresh feed item through extract→LLM with **no
score gate**, to auto-publish into the album.

## Consequences

- Album-import submissions carry a distinct origin tag (e.g. `album:<slug>`), so
  `processLlm`'s gate-2 screening — which only fires on `auto:*` rows — never
  applies to them. They run the full pipeline like manual submissions.
- Import is **one-shot on demand**, not a cron. Pulling in a source's new
  articles later means clicking import again. (An incremental/cron follow mode
  was considered and deferred — the motivating source is a closed archive.)
- Dedup reuses the normalized-URL check: already-processed URLs are skipped; an
  existing Pick with no album is adopted into the album; a Pick already in
  another album is skipped.
- Extraction still depends on fetching each article from its origin
  (`paulgraham.com` etc.), since the feed carries only title + link — no body,
  no date.
