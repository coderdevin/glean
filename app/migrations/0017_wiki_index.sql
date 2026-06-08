-- Wiki index: the LLM-synthesized "map of the corpus". Published picks are the
-- raw data; admin rebuilds this on demand and a rebuild publishes live (no draft
-- state). The newest row is the live index; older rows are kept as history.
CREATE TABLE `wiki_index` (
	`id` text PRIMARY KEY NOT NULL,
	`intro_zh` text NOT NULL,
	`intro_en` text NOT NULL,
	`topics_json` text DEFAULT '[]' NOT NULL,
	`model` text,
	`picks_count` integer DEFAULT 0 NOT NULL,
	`generated_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wiki_index_generated_idx` ON `wiki_index` (`generated_at`);
