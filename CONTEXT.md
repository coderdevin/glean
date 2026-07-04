# Glean — Domain Language

Glean is a bilingual (中/英) editorial pipeline: links travel through a queue +
human review queue and are published as curated picks that readers browse. This
glossary defines the terms specific to that domain. It is a glossary only — no
implementation details.

## Language

**Pick**:
A published article that readers see (on `/`, `/daily`, `/weekly`, `/a/<slug>`,
RSS). The public artifact of the pipeline.
_Avoid_: post, entry, link (a "link" is pre-publish).

**Submission**:
A link inside the review pipeline, before it becomes a Pick. Carries the AI
draft (`ai_*` fields) and a pipeline status. Not public.
_Avoid_: pick (a submission is not yet public).

**Weekly Issue**:
A **time-boxed** bundle of Picks for one week, with a bilingual title, intro,
cover, and an ordered section layout. Contrast with an Album, which is
theme/source-boxed and persistent rather than tied to a date range.

### Albums feature (in design)

**Album (专辑)**:
A curated, ordered, **persistent** collection of published Picks with its own
bilingual title, intro, and cover — grouped by theme or source rather than by
time. A Pick belongs to **at most one** Album (single membership). An Album has a
draft/published lifecycle; its Picks are **out of the daily/weekly streams** and
become publicly visible only once the Album itself is published.
_Avoid_: collection, series, issue (an "issue" is the weekly, time-boxed thing).

**Feed (订阅源)**:
A subscribed source — typically an RSS/Atom URL, configured on an Album — whose
articles are **bulk-imported** into the Submission pipeline on demand, bypassing
the score gates that the discovery firehose applies. A Feed is the **ingest**
mechanism; it is distinct from the Album its articles land in.
_Avoid_: source (overloaded — `submissions.source` is the origin tag; a Feed is
the configured subscription), channel, album (a Feed is not the collection),
discovery (discovery is the separate, gated, cron-driven firehose).

**Album import**:
The on-demand action that reads an Album's Feed, dedups against existing
Submissions/Picks, and enqueues every fresh article through the normal
extract→LLM pipeline — ungated — to auto-publish into that Album. Contrast with
**discovery**, the cron-driven, score-gated firehose that feeds the daily stream.
