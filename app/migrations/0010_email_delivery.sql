-- Newsletter delivery: opt-out tracking + per-issue email send audit.

-- Subscribers can opt out; weekly delivery skips anyone with a non-null value.
ALTER TABLE subscribers ADD COLUMN unsubscribed_at integer;

-- When an issue's email blast was first sent (null = never emailed).
ALTER TABLE weekly_issues ADD COLUMN email_sent_at integer;

-- One row per (issue, recipient). Makes re-sending idempotent (skip rows
-- already 'sent') and provides an audit trail of who got which issue.
CREATE TABLE weekly_deliveries (
  issue_id text NOT NULL,
  email text NOT NULL,
  status text NOT NULL,           -- 'sent' | 'failed'
  error text,
  sent_at integer NOT NULL,
  PRIMARY KEY (issue_id, email)
);
CREATE INDEX weekly_deliveries_issue_idx ON weekly_deliveries (issue_id);
