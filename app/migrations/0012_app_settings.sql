-- Generic runtime key/value settings shared by the Pages app and the queue
-- workers (both bind D1). First use: the default LLM provider toggle
-- (modelscope | deepseek | openai) so admins can switch without a redeploy.
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
