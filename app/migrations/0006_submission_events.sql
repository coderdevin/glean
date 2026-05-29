-- Per-submission pipeline event log. Each extract / llm stage transition
-- writes a row so the admin UI can render a full timeline without grepping
-- Cloudflare logs. `meta_json` is a free-form JSON blob; the renderer treats
-- it as opaque except for a few well-known keys (latency_ms, model, attempt,
-- chars).

CREATE TABLE submission_events (
  id            text    PRIMARY KEY,
  submission_id text    NOT NULL,
  stage         text    NOT NULL CHECK (stage IN ('queue','extract','llm','pipeline')),
  status        text    NOT NULL CHECK (status IN ('queued','started','ok','failed','rejected','skipped')),
  message       text,
  meta_json     text,
  created_at    integer NOT NULL
);
CREATE INDEX submission_events_sub_idx ON submission_events (submission_id, created_at);
