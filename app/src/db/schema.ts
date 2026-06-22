import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";

export const SUBMISSION_STATUSES = [
  "pending",    // submitted, awaiting pipeline
  "analyzing",  // extract + phase-1 LLM (card fields)
  "composing",  // phase-2 LLM (bilingual body sections)
  "ready",      // AI fully done — editor publishes or rejects
  "published",
  "rejected",   // editor decision (human)
  "failed",     // AI failed at some stage (retriable)
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const CATEGORIES = ["infra", "data", "code"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Published picks — what readers see. */
export const picks = sqliteTable(
  "picks",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),

    titleZh: text("title_zh").notNull(),
    titleEn: text("title_en").notNull(),
    summaryZh: text("summary_zh").notNull(),
    summaryEn: text("summary_en").notNull(),
    bulletsJson: text("bullets_json").notNull().default("[]"),
    editorNoteZh: text("editor_note_zh"),
    editorNoteEn: text("editor_note_en"),
    /** Source article language. Drives the modebar label flip on the
     *  reader so we don't claim "英文原文" for a Chinese source. */
    lang: text("lang"),

    sourceUrl: text("source_url").notNull(),
    sourceHost: text("source_host").notNull(),
    readMinutes: integer("read_minutes").notNull().default(5),

    // Free-form category slug — references the self-growing `categories` table
    // (formerly the infra/data/code enum). Plain text; sanitizeCategory validates.
    category: text("category").notNull(),

    dailyDate: text("daily_date").notNull(),
    weeklyIssueId: text("weekly_issue_id"),
    positionInDay: integer("position_in_day").notNull().default(0),

    score: real("score").notNull().default(0),
    submitterName: text("submitter_name"),

    // AI v2: editorial extras kept on the published pick.
    glossaryJson: text("glossary_json"),
    nextHintsJson: text("next_hints_json"),
    sectionsJson: text("sections_json"),

    status: text("status", { enum: ["draft", "published"] as const })
      .notNull()
      .default("published"),

    publishedAt: integer("published_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    dailyIdx: index("picks_daily_idx").on(t.dailyDate, t.positionInDay),
    weeklyIdx: index("picks_weekly_idx").on(t.weeklyIssueId),
    statusIdx: index("picks_status_idx").on(t.status, t.publishedAt),
  }),
);

/** Weekly issues — bundles of picks. */
export const weeklyIssues = sqliteTable("weekly_issues", {
  id: text("id").primaryKey(),
  number: integer("number").notNull().unique(),
  slug: text("slug").notNull().unique(),

  titleZh: text("title_zh").notNull(),
  titleEn: text("title_en").notNull(),

  dateStart: text("date_start").notNull(),
  dateEnd: text("date_end").notNull(),

  introZh: text("intro_zh").notNull(),
  introEn: text("intro_en").notNull(),

  coverImageKey: text("cover_image_key"),
  layoutJson: text("layout_json"),

  // Async AI drafting (see migration 0011). 'drafting' | 'ready' | 'failed';
  // null only on rows predating the migration (treated as 'ready').
  draftStatus: text("draft_status"),
  draftError: text("draft_error"),
  draftStartedAt: integer("draft_started_at", { mode: "timestamp" }),

  // On-demand editorial self-review (see migration 0018). The LLM critiques the
  // current draft; the editor edits `reviewFeedback` and triggers a feedback-
  // guided re-draft (kind=weekly-refine). reviewStatus is INDEPENDENT of
  // draftStatus — generating a review never un-readies a published-ready draft.
  reviewJson: text("review_json"),                  // {strengths[], weaknesses[], suggestions}
  reviewStatus: text("review_status"),              // null | 'reviewing' | 'ready' | 'failed'
  reviewError: text("review_error"),
  reviewFeedback: text("review_feedback"),          // editor-editable 改进方向, consumed by refine
  reviewStartedAt: integer("review_started_at", { mode: "timestamp" }),

  emailSentAt: integer("email_sent_at", { mode: "timestamp" }),

  publishedAt: integer("published_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Wiki index — the LLM-synthesized "map of the corpus" (see migration 0017).
 * Published picks are the raw data; admin rebuilds this index on demand and a
 * rebuild publishes live (no draft state). The newest row is the live index.
 */
export const wikiIndex = sqliteTable("wiki_index", {
  id: text("id").primaryKey(),
  introZh: text("intro_zh").notNull(),
  introEn: text("intro_en").notNull(),
  /** JSON: [{title_zh,title_en,blurb_zh,blurb_en,pick_slugs:[]}] */
  topicsJson: text("topics_json").notNull().default("[]"),
  model: text("model"),
  /** Snapshot of how many published picks were folded in at generation time. */
  picksCount: integer("picks_count").notNull().default(0),
  generatedAt: integer("generated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Self-growing tag taxonomy. `family` is a category slug (see `categories`). */
export const tags = sqliteTable("tags", {
  slug: text("slug").primaryKey(),
  nameZh: text("name_zh").notNull(),
  nameEn: text("name_en").notNull(),
  family: text("family").notNull(),
});

/** Self-growing category taxonomy — also used as `tags.family` and
 *  `picks.category`. The 3 seeded rows (infra/data/code) keep hand-tuned brand
 *  colors; any new category's badge color is derived from its slug at render
 *  (color = null). Grows via upsert at ingest, like tags. */
export const categories = sqliteTable("categories", {
  slug: text("slug").primaryKey(),
  nameZh: text("name_zh").notNull(),
  nameEn: text("name_en").notNull(),
  color: text("color"),
});

export const pickTags = sqliteTable(
  "pick_tags",
  {
    pickId: text("pick_id").notNull(),
    tagSlug: text("tag_slug").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.pickId, t.tagSlug] }),
    tagIdx: index("pick_tags_tag_idx").on(t.tagSlug),
  }),
);

/** Incoming submissions queue. */
export const submissions = sqliteTable(
  "submissions",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    note: text("note"),
    submitterName: text("submitter_name"),
    submitterIpHash: text("submitter_ip_hash"),

    status: text("status", { enum: SUBMISSION_STATUSES })
      .notNull()
      .default("pending"),
    rejectReason: text("reject_reason"),

    rawR2Key: text("raw_r2_key"),
    extractedLang: text("extracted_lang"),
    /** The source article's own title, captured at extract time (≤256 chars).
     *  Read-only reference shown in admin so the editor can compare against the
     *  AI-rewritten ai_title_* fields. Not published. Null on rows predating
     *  migration 0015 or when the source had no title. */
    originalTitle: text("original_title"),

    aiTitleZh: text("ai_title_zh"),
    aiTitleEn: text("ai_title_en"),
    aiSummaryZh: text("ai_summary_zh"),
    aiSummaryEn: text("ai_summary_en"),
    aiBulletsJson: text("ai_bullets_json"),
    aiTagsJson: text("ai_tags_json"),
    aiCategory: text("ai_category"),
    aiScore: real("ai_score"),
    aiSubscoresJson: text("ai_subscores_json"),
    aiGlossaryJson: text("ai_glossary_json"),
    aiNextHintsJson: text("ai_next_hints_json"),
    aiSectionsJson: text("ai_sections_json"),
    /** @deprecated Superseded by `status` (analyzing/composing/ready/failed).
     *  No longer read or written. Kept dormant to avoid a destructive D1
     *  column drop; remove in a later migration once confirmed unused. */
    aiSectionsStatus: text("ai_sections_status", {
      enum: ["pending", "ok", "failed"] as const,
    }),
    /** Failure detail text when status='failed' (was the sections error). */
    aiSectionsError: text("ai_sections_error"),
    /** Which pipeline stage failed, when status='failed'. */
    failureStage: text("failure_stage", {
      enum: ["extract", "analysis", "sections"] as const,
    }),
    aiModel: text("ai_model"),
    aiLatencyMs: integer("ai_latency_ms"),
    aiTokens: integer("ai_tokens"),
    processingStartedAt: integer("processing_started_at", { mode: "timestamp" }),
    processingModel: text("processing_model"),

    editorNoteZh: text("editor_note_zh"),
    editorNoteEn: text("editor_note_en"),

    linkedPickId: text("linked_pick_id"),

    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    processedAt: integer("processed_at", { mode: "timestamp" }),
    reviewedAt: integer("reviewed_at", { mode: "timestamp" }),
  },
  (t) => ({
    statusIdx: index("submissions_status_idx").on(t.status, t.createdAt),
  }),
);

/** Email subscribers. Double opt-in: confirmedAt set after the user clicks the
 *  confirmation link; weekly delivery targets confirmed, non-unsubscribed rows. */
export const subscribers = sqliteTable("subscribers", {
  email: text("email").primaryKey(),
  langPref: text("lang_pref", { enum: ["zh", "en"] as const }).notNull(),
  source: text("source").notNull(),
  confirmToken: text("confirm_token"),
  confirmedAt: integer("confirmed_at", { mode: "timestamp" }),
  unsubscribedAt: integer("unsubscribed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** One row per (issue, recipient) email attempt. Makes re-sending idempotent
 *  (skip rows already 'sent') and provides a who-got-what audit trail. */
export const weeklyDeliveries = sqliteTable(
  "weekly_deliveries",
  {
    issueId: text("issue_id").notNull(),
    email: text("email").notNull(),
    status: text("status", { enum: ["sent", "failed"] as const }).notNull(),
    error: text("error"),
    sentAt: integer("sent_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.issueId, t.email] }),
    issueIdx: index("weekly_deliveries_issue_idx").on(t.issueId),
  }),
);

/** Reader accounts (passwordless / magic-link). Distinct from the admin gate —
 *  these identify public readers so their reading notes sync across devices.
 *  Identity is the email; the session cookie carries the readers.id. */
export const readers = sqliteTable("readers", {
  id: text("id").primaryKey(), // ULID
  email: text("email").notNull().unique(), // lowercased
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
});

export const READER_NOTE_COLORS = ["yellow", "green", "pink"] as const;
export type ReaderNoteColor = (typeof READER_NOTE_COLORS)[number];

/** A reader's highlight (+ optional annotation) anchored to a passage of a
 *  published pick. Anchoring is text-quote based (exact + prefix/suffix +
 *  offset hint) so it survives editorial re-publishes; see lib/anchor.ts.
 *  `note` null = highlight only. Bilingual: a note is bound to one language
 *  pane (`lang`) — a zh highlight never shows on the en column. */
export const readerNotes = sqliteTable(
  "reader_notes",
  {
    id: text("id").primaryKey(), // ULID
    readerId: text("reader_id").notNull(),
    pickId: text("pick_id").notNull(),
    sectionIndex: integer("section_index").notNull(), // 1-based, matches row-{i}
    lang: text("lang", { enum: ["zh", "en"] as const }).notNull(),
    exact: text("exact").notNull(), // the highlighted quote
    prefix: text("prefix"), // chars before the quote (disambiguation)
    suffix: text("suffix"), // chars after the quote
    startOffset: integer("start_offset").notNull(), // char offset hint in section text
    color: text("color", { enum: READER_NOTE_COLORS }).notNull().default("yellow"),
    note: text("note"), // annotation; null = highlight only
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    readerPickIdx: index("reader_notes_reader_pick_idx").on(t.readerId, t.pickId),
    pickIdx: index("reader_notes_pick_idx").on(t.pickId), // future: popular highlights
    readerIdx: index("reader_notes_reader_idx").on(t.readerId, t.createdAt),
  }),
);

export const EVENT_STAGES = ["queue", "extract", "llm", "pipeline"] as const;
export type EventStage = (typeof EVENT_STAGES)[number];

export const EVENT_STATUSES = [
  "queued",
  "started",
  "ok",
  "failed",
  "rejected",
  "skipped",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Pipeline event log for a submission. One row per stage transition.
 *  Read by the admin detail page to render a timeline. */
export const submissionEvents = sqliteTable(
  "submission_events",
  {
    id: text("id").primaryKey(),
    submissionId: text("submission_id").notNull(),
    stage: text("stage", { enum: EVENT_STAGES }).notNull(),
    status: text("status", { enum: EVENT_STATUSES }).notNull(),
    message: text("message"),
    metaJson: text("meta_json"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    subIdx: index("submission_events_sub_idx").on(t.submissionId, t.createdAt),
  }),
);

/** Side-panel annotations on the article reader. */
export const articleAnnotations = sqliteTable(
  "article_annotations",
  {
    id: text("id").primaryKey(),
    pickId: text("pick_id").notNull(),
    anchor: text("anchor").notNull(),
    bodyZh: text("body_zh").notNull(),
    bodyEn: text("body_en").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => ({
    pickIdx: index("annotations_pick_idx").on(t.pickId, t.position),
  }),
);

/** Generic key/value store for runtime-tunable app settings that must be
 *  shared between the Pages app (admin writes) and the queue workers (read) —
 *  e.g. the default LLM provider toggle. D1 is the only store both reach. */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Pick = typeof picks.$inferSelect;
export type NewPick = typeof picks.$inferInsert;
export type WeeklyIssue = typeof weeklyIssues.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type Submission = typeof submissions.$inferSelect;
export type NewSubmission = typeof submissions.$inferInsert;
export type Subscriber = typeof subscribers.$inferSelect;
export type ArticleAnnotation = typeof articleAnnotations.$inferSelect;
export type SubmissionEvent = typeof submissionEvents.$inferSelect;
export type NewSubmissionEvent = typeof submissionEvents.$inferInsert;
