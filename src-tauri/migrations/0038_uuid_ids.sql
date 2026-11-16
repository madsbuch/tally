-- Every row is keyed by a UUID string instead of an auto-increment integer,
-- so two devices syncing into one vault can never hand out the same id.
--
-- Existing rows keep their number, re-spelled as
-- `00000000-0000-7000-8000-<12 hex digits>` (lib/ids.ts `legacyId`); every
-- column that points at a row is re-spelled the same way, so links survive
-- and the old ids still sort first, in their old order.
--
-- Migrations run inside a transaction with foreign keys ON, where
-- `PRAGMA foreign_keys = OFF` is ignored. So instead of the usual
-- rebuild-one-table-at-a-time, all new tables are created first with their
-- references pointing at each other's `__new_` names, filled parents first,
-- the old tables dropped children first, and the new ones renamed into place
-- (renaming rewrites the references along with the name).
--
-- Also: `food_entries.diet` (unused) is gone, and device-local settings move
-- out of `settings` into `device_settings`.
PRAGMA defer_foreign_keys = ON;--> statement-breakpoint
CREATE TABLE `device_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`day` text NOT NULL,
	`source` text NOT NULL,
	`chat_id` text,
	`model` text NOT NULL,
	`requests` integer NOT NULL,
	`prompt_tokens` integer NOT NULL,
	`cached_tokens` integer NOT NULL,
	`completion_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_blood_readings` (
	`id` text PRIMARY KEY NOT NULL,
	`measured_at` text NOT NULL,
	`kind` text NOT NULL,
	`value` real NOT NULL,
	`note` text,
	`day` text NOT NULL,
	`tz_offset_min` integer NOT NULL,
	`photo_path` text
);--> statement-breakpoint
CREATE TABLE `__new_captures` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`day` text NOT NULL,
	`note` text,
	`photo_path` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text
);--> statement-breakpoint
CREATE TABLE `__new_chats` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`title` text NOT NULL,
	`messages` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_coach_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`status` text,
	`follow_up_on` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_coach_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_key` text NOT NULL,
	`day` text NOT NULL,
	`created_at` text NOT NULL,
	`chat_id` text
);--> statement-breakpoint
CREATE TABLE `__new_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`document_date` text,
	`title` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`photo_path` text,
	`note` text,
	`summary` text,
	`extracted` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`model_id` text,
	`page_paths` text DEFAULT '[]' NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_entry_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_kind` text NOT NULL,
	`entry_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`changes` text DEFAULT '[]' NOT NULL,
	`before_entry` text,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_entry_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_kind` text NOT NULL,
	`entry_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`hypothesis` text NOT NULL,
	`applies_when` text,
	`arms` text NOT NULL,
	`measures` text NOT NULL,
	`assignment` text NOT NULL,
	`target_per_arm` integer NOT NULL,
	`status` text NOT NULL,
	`conclusion` text,
	`manual_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ended_at` text
);--> statement-breakpoint
CREATE TABLE `__new_fasts` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`goal_hours` real NOT NULL,
	`purpose` text,
	`ended_at` text,
	`start_day` text,
	`end_day` text,
	`tz_offset_min` integer
);--> statement-breakpoint
CREATE TABLE `__new_food_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`eaten_at` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`photo_path` text,
	`nutrients` text DEFAULT '{}' NOT NULL,
	`model_id` text,
	`icon` text,
	`day` text,
	`tz_offset_min` integer,
	`fast_ok_note` text
);--> statement-breakpoint
CREATE TABLE `__new_garmin_activities` (
	`activity_id` text PRIMARY KEY NOT NULL,
	`workout_id` text,
	`dismissed` integer DEFAULT 0 NOT NULL,
	`linked_by` text,
	`started_at` text NOT NULL,
	`duration_sec` real,
	`type_key` text,
	`name` text,
	`distance_m` real,
	`avg_hr` real,
	`max_hr` real,
	`calories` real,
	`aerobic_te` real,
	`anaerobic_te` real,
	`te_label` text,
	`training_load` real,
	`avg_power` real,
	`max_power` real,
	`norm_power` real,
	`avg_cadence` real,
	`elevation_gain_m` real,
	`avg_speed_mps` real,
	`vo2_max` real,
	`zone_secs` text,
	`laps` text,
	`summary` text,
	`updated_at` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_manuals` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`situation` text NOT NULL,
	`applies_when` text,
	`body` text NOT NULL,
	`edited_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_performance_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`measured_at` text NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`photo_path` text,
	`model_id` text,
	`day` text NOT NULL,
	`tz_offset_min` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_progress_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`taken_at` text NOT NULL,
	`day` text NOT NULL,
	`tz_offset_min` integer NOT NULL,
	`photo_path` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_saved_meals` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`nutrients` text DEFAULT '{}' NOT NULL,
	`icon` text,
	`source_entry_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_sleep_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`duration_min` real NOT NULL,
	`deep_min` real,
	`rem_min` real,
	`light_min` real,
	`awake_min` real,
	`source` text,
	`day` text,
	`tz_offset_min` integer,
	`source_record_id` text
);--> statement-breakpoint
CREATE TABLE `__new_state_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`icon` text NOT NULL,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_state_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`logged_at` text NOT NULL,
	`note` text,
	`tagging` text,
	`day` text NOT NULL,
	`tz_offset_min` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_supplements` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`dose_amount` real,
	`dose_unit` text,
	`nutrients` text DEFAULT '{}' NOT NULL,
	`notes` text,
	`archived` integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE TABLE `__new_workouts` (
	`id` text PRIMARY KEY NOT NULL,
	`performed_at` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`photo_path` text,
	`calories_burned` real DEFAULT 0 NOT NULL,
	`duration_min` real,
	`avg_hr` real,
	`zone2_min` real,
	`cardio` integer DEFAULT 0 NOT NULL,
	`cardio_by_hand` integer DEFAULT 0 NOT NULL,
	`model_id` text,
	`icon` text,
	`source` text,
	`external_id` text,
	`day` text,
	`tz_offset_min` integer,
	`source_record_id` text
);--> statement-breakpoint
CREATE TABLE `__new_document_files` (
	`document_id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`data` blob NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `__new_documents`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `__new_experiment_trials` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`arm` text NOT NULL,
	`fast_id` text,
	`started_at` text NOT NULL,
	`day` text NOT NULL,
	`tz_offset_min` integer NOT NULL,
	`ratings` text,
	`note` text,
	`excluded` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `__new_experiments`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `__new_manual_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`manual_id` text NOT NULL,
	`title` text NOT NULL,
	`situation` text NOT NULL,
	`body` text NOT NULL,
	`edited_by` text NOT NULL,
	`written_at` text NOT NULL,
	FOREIGN KEY (`manual_id`) REFERENCES `__new_manuals`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `__new_performance_stats` (
	`id` text PRIMARY KEY NOT NULL,
	`log_id` text NOT NULL,
	`metric` text NOT NULL,
	`label` text NOT NULL,
	`value` real NOT NULL,
	`unit` text,
	FOREIGN KEY (`log_id`) REFERENCES `__new_performance_logs`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `__new_state_log_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`log_id` text NOT NULL,
	`label` text NOT NULL,
	`icon` text,
	FOREIGN KEY (`log_id`) REFERENCES `__new_state_logs`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `__new_supplement_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`supplement_id` text NOT NULL,
	`taken_at` text NOT NULL,
	`amount` real DEFAULT 1 NOT NULL,
	`day` text,
	`tz_offset_min` integer,
	FOREIGN KEY (`supplement_id`) REFERENCES `__new_supplements`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_ai_usage`("id", "created_at", "day", "source", "chat_id", "model", "requests", "prompt_tokens", "cached_tokens", "completion_tokens", "cost_usd") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "created_at", "day", "source", CASE WHEN "chat_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "chat_id") END, "model", "requests", "prompt_tokens", "cached_tokens", "completion_tokens", "cost_usd" FROM `ai_usage`;--> statement-breakpoint
INSERT INTO `__new_blood_readings`("id", "measured_at", "kind", "value", "note", "day", "tz_offset_min", "photo_path") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "measured_at", "kind", "value", "note", "day", "tz_offset_min", "photo_path" FROM `blood_readings`;--> statement-breakpoint
INSERT INTO `__new_captures`("id", "created_at", "day", "note", "photo_path", "status", "error") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "created_at", "day", "note", "photo_path", "status", "error" FROM `captures`;--> statement-breakpoint
INSERT INTO `__new_chats`("id", "created_at", "updated_at", "title", "messages") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "created_at", "updated_at", "title", "messages" FROM `chats`;--> statement-breakpoint
INSERT INTO `__new_coach_memory`("id", "kind", "text", "status", "follow_up_on", "created_at", "updated_at") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "kind", "text", "status", "follow_up_on", "created_at", "updated_at" FROM `coach_memory`;--> statement-breakpoint
INSERT INTO `__new_coach_runs`("id", "trigger_key", "day", "created_at", "chat_id") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "trigger_key", "day", "created_at", CASE WHEN "chat_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "chat_id") END FROM `coach_runs`;--> statement-breakpoint
INSERT INTO `__new_documents`("id", "created_at", "document_date", "title", "kind", "photo_path", "note", "summary", "extracted", "status", "error", "model_id", "page_paths") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "created_at", "document_date", "title", "kind", "photo_path", "note", "summary", "extracted", "status", "error", "model_id", "page_paths" FROM `documents`;--> statement-breakpoint
INSERT INTO `__new_entry_messages`("id", "entry_kind", "entry_id", "role", "text", "changes", "before_entry", "created_at") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "entry_kind", CASE WHEN "entry_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "entry_id") END, "role", "text", "changes", "before_entry", "created_at" FROM `entry_messages`;--> statement-breakpoint
INSERT INTO `__new_entry_notes`("id", "entry_kind", "entry_id", "text", "created_at") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "entry_kind", CASE WHEN "entry_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "entry_id") END, "text", "created_at" FROM `entry_notes`;--> statement-breakpoint
INSERT INTO `__new_experiments`("id", "title", "hypothesis", "applies_when", "arms", "measures", "assignment", "target_per_arm", "status", "conclusion", "manual_id", "created_at", "updated_at", "ended_at") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "title", "hypothesis", "applies_when", "arms", "measures", "assignment", "target_per_arm", "status", "conclusion", CASE WHEN "manual_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "manual_id") END, "created_at", "updated_at", "ended_at" FROM `experiments`;--> statement-breakpoint
INSERT INTO `__new_fasts`("id", "started_at", "goal_hours", "purpose", "ended_at", "start_day", "end_day", "tz_offset_min") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "started_at", "goal_hours", "purpose", "ended_at", "start_day", "end_day", "tz_offset_min" FROM `fasts`;--> statement-breakpoint
INSERT INTO `__new_food_entries`("id", "eaten_at", "title", "description", "photo_path", "nutrients", "model_id", "icon", "day", "tz_offset_min", "fast_ok_note") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "eaten_at", "title", "description", "photo_path", "nutrients", "model_id", "icon", "day", "tz_offset_min", "fast_ok_note" FROM `food_entries`;--> statement-breakpoint
INSERT INTO `__new_garmin_activities`("activity_id", "workout_id", "dismissed", "linked_by", "started_at", "duration_sec", "type_key", "name", "distance_m", "avg_hr", "max_hr", "calories", "aerobic_te", "anaerobic_te", "te_label", "training_load", "avg_power", "max_power", "norm_power", "avg_cadence", "elevation_gain_m", "avg_speed_mps", "vo2_max", "zone_secs", "laps", "summary", "updated_at") SELECT "activity_id", CASE WHEN "workout_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "workout_id") END, "dismissed", "linked_by", "started_at", "duration_sec", "type_key", "name", "distance_m", "avg_hr", "max_hr", "calories", "aerobic_te", "anaerobic_te", "te_label", "training_load", "avg_power", "max_power", "norm_power", "avg_cadence", "elevation_gain_m", "avg_speed_mps", "vo2_max", "zone_secs", "laps", "summary", "updated_at" FROM `garmin_activities`;--> statement-breakpoint
INSERT INTO `__new_manuals`("id", "title", "situation", "applies_when", "body", "edited_by", "created_at", "updated_at") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "title", "situation", "applies_when", "body", "edited_by", "created_at", "updated_at" FROM `manuals`;--> statement-breakpoint
INSERT INTO `__new_performance_logs`("id", "measured_at", "title", "note", "photo_path", "model_id", "day", "tz_offset_min") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "measured_at", "title", "note", "photo_path", "model_id", "day", "tz_offset_min" FROM `performance_logs`;--> statement-breakpoint
INSERT INTO `__new_progress_photos`("id", "taken_at", "day", "tz_offset_min", "photo_path") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "taken_at", "day", "tz_offset_min", "photo_path" FROM `progress_photos`;--> statement-breakpoint
INSERT INTO `__new_saved_meals`("id", "name", "description", "nutrients", "icon", "source_entry_id", "created_at", "updated_at") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "name", "description", "nutrients", "icon", CASE WHEN "source_entry_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "source_entry_id") END, "created_at", "updated_at" FROM `saved_meals`;--> statement-breakpoint
INSERT INTO `__new_sleep_sessions`("id", "external_id", "started_at", "ended_at", "duration_min", "deep_min", "rem_min", "light_min", "awake_min", "source", "day", "tz_offset_min", "source_record_id") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "external_id", "started_at", "ended_at", "duration_min", "deep_min", "rem_min", "light_min", "awake_min", "source", "day", "tz_offset_min", "source_record_id" FROM `sleep_sessions`;--> statement-breakpoint
INSERT INTO `__new_state_categories`("id", "label", "icon", "created_at") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "label", "icon", "created_at" FROM `state_categories`;--> statement-breakpoint
INSERT INTO `__new_state_logs`("id", "logged_at", "note", "tagging", "day", "tz_offset_min") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "logged_at", "note", "tagging", "day", "tz_offset_min" FROM `state_logs`;--> statement-breakpoint
INSERT INTO `__new_supplements`("id", "name", "dose_amount", "dose_unit", "nutrients", "notes", "archived") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "name", "dose_amount", "dose_unit", "nutrients", "notes", "archived" FROM `supplements`;--> statement-breakpoint
INSERT INTO `__new_workouts`("id", "performed_at", "title", "description", "photo_path", "calories_burned", "duration_min", "avg_hr", "zone2_min", "cardio", "cardio_by_hand", "model_id", "icon", "source", "external_id", "day", "tz_offset_min", "source_record_id") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, "performed_at", "title", "description", "photo_path", "calories_burned", "duration_min", "avg_hr", "zone2_min", "cardio", "cardio_by_hand", "model_id", "icon", "source", "external_id", "day", "tz_offset_min", "source_record_id" FROM `workouts`;--> statement-breakpoint
INSERT INTO `__new_document_files`("document_id", "filename", "media_type", "data") SELECT CASE WHEN "document_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "document_id") END, "filename", "media_type", "data" FROM `document_files`;--> statement-breakpoint
INSERT INTO `__new_experiment_trials`("id", "experiment_id", "arm", "fast_id", "started_at", "day", "tz_offset_min", "ratings", "note", "excluded", "created_at", "updated_at") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, CASE WHEN "experiment_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "experiment_id") END, "arm", CASE WHEN "fast_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "fast_id") END, "started_at", "day", "tz_offset_min", "ratings", "note", "excluded", "created_at", "updated_at" FROM `experiment_trials`;--> statement-breakpoint
INSERT INTO `__new_manual_revisions`("id", "manual_id", "title", "situation", "body", "edited_by", "written_at") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, CASE WHEN "manual_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "manual_id") END, "title", "situation", "body", "edited_by", "written_at" FROM `manual_revisions`;--> statement-breakpoint
INSERT INTO `__new_performance_stats`("id", "log_id", "metric", "label", "value", "unit") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, CASE WHEN "log_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "log_id") END, "metric", "label", "value", "unit" FROM `performance_stats`;--> statement-breakpoint
INSERT INTO `__new_state_log_tags`("id", "log_id", "label", "icon") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, CASE WHEN "log_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "log_id") END, "label", "icon" FROM `state_log_tags`;--> statement-breakpoint
INSERT INTO `__new_supplement_logs`("id", "supplement_id", "taken_at", "amount", "day", "tz_offset_min") SELECT CASE WHEN "id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "id") END, CASE WHEN "supplement_id" IS NULL THEN NULL ELSE printf('00000000-0000-7000-8000-%012x', "supplement_id") END, "taken_at", "amount", "day", "tz_offset_min" FROM `supplement_logs`;--> statement-breakpoint
DROP TABLE `document_files`;--> statement-breakpoint
DROP TABLE `experiment_trials`;--> statement-breakpoint
DROP TABLE `manual_revisions`;--> statement-breakpoint
DROP TABLE `performance_stats`;--> statement-breakpoint
DROP TABLE `state_log_tags`;--> statement-breakpoint
DROP TABLE `supplement_logs`;--> statement-breakpoint
DROP TABLE `ai_usage`;--> statement-breakpoint
DROP TABLE `blood_readings`;--> statement-breakpoint
DROP TABLE `captures`;--> statement-breakpoint
DROP TABLE `chats`;--> statement-breakpoint
DROP TABLE `coach_memory`;--> statement-breakpoint
DROP TABLE `coach_runs`;--> statement-breakpoint
DROP TABLE `documents`;--> statement-breakpoint
DROP TABLE `entry_messages`;--> statement-breakpoint
DROP TABLE `entry_notes`;--> statement-breakpoint
DROP TABLE `experiments`;--> statement-breakpoint
DROP TABLE `fasts`;--> statement-breakpoint
DROP TABLE `food_entries`;--> statement-breakpoint
DROP TABLE `garmin_activities`;--> statement-breakpoint
DROP TABLE `manuals`;--> statement-breakpoint
DROP TABLE `performance_logs`;--> statement-breakpoint
DROP TABLE `progress_photos`;--> statement-breakpoint
DROP TABLE `saved_meals`;--> statement-breakpoint
DROP TABLE `sleep_sessions`;--> statement-breakpoint
DROP TABLE `state_categories`;--> statement-breakpoint
DROP TABLE `state_logs`;--> statement-breakpoint
DROP TABLE `supplements`;--> statement-breakpoint
DROP TABLE `workouts`;--> statement-breakpoint
ALTER TABLE `__new_ai_usage` RENAME TO `ai_usage`;--> statement-breakpoint
ALTER TABLE `__new_blood_readings` RENAME TO `blood_readings`;--> statement-breakpoint
ALTER TABLE `__new_captures` RENAME TO `captures`;--> statement-breakpoint
ALTER TABLE `__new_chats` RENAME TO `chats`;--> statement-breakpoint
ALTER TABLE `__new_coach_memory` RENAME TO `coach_memory`;--> statement-breakpoint
ALTER TABLE `__new_coach_runs` RENAME TO `coach_runs`;--> statement-breakpoint
ALTER TABLE `__new_documents` RENAME TO `documents`;--> statement-breakpoint
ALTER TABLE `__new_entry_messages` RENAME TO `entry_messages`;--> statement-breakpoint
ALTER TABLE `__new_entry_notes` RENAME TO `entry_notes`;--> statement-breakpoint
ALTER TABLE `__new_experiments` RENAME TO `experiments`;--> statement-breakpoint
ALTER TABLE `__new_fasts` RENAME TO `fasts`;--> statement-breakpoint
ALTER TABLE `__new_food_entries` RENAME TO `food_entries`;--> statement-breakpoint
ALTER TABLE `__new_garmin_activities` RENAME TO `garmin_activities`;--> statement-breakpoint
ALTER TABLE `__new_manuals` RENAME TO `manuals`;--> statement-breakpoint
ALTER TABLE `__new_performance_logs` RENAME TO `performance_logs`;--> statement-breakpoint
ALTER TABLE `__new_progress_photos` RENAME TO `progress_photos`;--> statement-breakpoint
ALTER TABLE `__new_saved_meals` RENAME TO `saved_meals`;--> statement-breakpoint
ALTER TABLE `__new_sleep_sessions` RENAME TO `sleep_sessions`;--> statement-breakpoint
ALTER TABLE `__new_state_categories` RENAME TO `state_categories`;--> statement-breakpoint
ALTER TABLE `__new_state_logs` RENAME TO `state_logs`;--> statement-breakpoint
ALTER TABLE `__new_supplements` RENAME TO `supplements`;--> statement-breakpoint
ALTER TABLE `__new_workouts` RENAME TO `workouts`;--> statement-breakpoint
ALTER TABLE `__new_document_files` RENAME TO `document_files`;--> statement-breakpoint
ALTER TABLE `__new_experiment_trials` RENAME TO `experiment_trials`;--> statement-breakpoint
ALTER TABLE `__new_manual_revisions` RENAME TO `manual_revisions`;--> statement-breakpoint
ALTER TABLE `__new_performance_stats` RENAME TO `performance_stats`;--> statement-breakpoint
ALTER TABLE `__new_state_log_tags` RENAME TO `state_log_tags`;--> statement-breakpoint
ALTER TABLE `__new_supplement_logs` RENAME TO `supplement_logs`;--> statement-breakpoint
CREATE INDEX `idx_ai_usage_day` ON `ai_usage` (`day`);--> statement-breakpoint
CREATE INDEX `idx_ai_usage_chat` ON `ai_usage` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_blood_readings_day` ON `blood_readings` (`day`);--> statement-breakpoint
CREATE INDEX `idx_blood_readings_kind_measured_at` ON `blood_readings` (`kind`,`measured_at`);--> statement-breakpoint
CREATE INDEX `idx_captures_day` ON `captures` (`day`);--> statement-breakpoint
CREATE INDEX `idx_chats_updated_at` ON `chats` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_coach_memory_kind` ON `coach_memory` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_coach_runs_day` ON `coach_runs` (`day`);--> statement-breakpoint
CREATE INDEX `idx_documents_document_date` ON `documents` (`document_date`);--> statement-breakpoint
CREATE INDEX `idx_entry_messages_entry` ON `entry_messages` (`entry_kind`,`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_entry_notes_entry` ON `entry_notes` (`entry_kind`,`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_experiment_trials_experiment` ON `experiment_trials` (`experiment_id`);--> statement-breakpoint
CREATE INDEX `idx_experiment_trials_fast` ON `experiment_trials` (`fast_id`);--> statement-breakpoint
CREATE INDEX `idx_food_entries_eaten_at` ON `food_entries` (`eaten_at`);--> statement-breakpoint
CREATE INDEX `idx_food_entries_day` ON `food_entries` (`day`);--> statement-breakpoint
CREATE INDEX `idx_garmin_activities_workout` ON `garmin_activities` (`workout_id`);--> statement-breakpoint
CREATE INDEX `idx_garmin_activities_started_at` ON `garmin_activities` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_manual_revisions_manual` ON `manual_revisions` (`manual_id`);--> statement-breakpoint
CREATE INDEX `idx_performance_logs_day` ON `performance_logs` (`day`);--> statement-breakpoint
CREATE INDEX `idx_performance_logs_measured_at` ON `performance_logs` (`measured_at`);--> statement-breakpoint
CREATE INDEX `idx_performance_stats_log` ON `performance_stats` (`log_id`);--> statement-breakpoint
CREATE INDEX `idx_performance_stats_metric` ON `performance_stats` (`metric`);--> statement-breakpoint
CREATE INDEX `idx_progress_photos_taken_at` ON `progress_photos` (`taken_at`);--> statement-breakpoint
CREATE INDEX `idx_saved_meals_name` ON `saved_meals` (`name`);--> statement-breakpoint
CREATE INDEX `idx_sleep_sessions_day` ON `sleep_sessions` (`day`);--> statement-breakpoint
CREATE INDEX `idx_sleep_sessions_started_at` ON `sleep_sessions` (`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sleep_sessions_external_id` ON `sleep_sessions` (`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_state_categories_label` ON `state_categories` (`label`);--> statement-breakpoint
CREATE INDEX `idx_state_log_tags_log` ON `state_log_tags` (`log_id`);--> statement-breakpoint
CREATE INDEX `idx_state_log_tags_label` ON `state_log_tags` (`label`);--> statement-breakpoint
CREATE INDEX `idx_state_logs_day` ON `state_logs` (`day`);--> statement-breakpoint
CREATE INDEX `idx_state_logs_logged_at` ON `state_logs` (`logged_at`);--> statement-breakpoint
CREATE INDEX `idx_supplement_logs_taken_at` ON `supplement_logs` (`taken_at`);--> statement-breakpoint
CREATE INDEX `idx_supplement_logs_day` ON `supplement_logs` (`day`);--> statement-breakpoint
CREATE INDEX `idx_workouts_performed_at` ON `workouts` (`performed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workouts_external_id` ON `workouts` (`external_id`);--> statement-breakpoint
CREATE INDEX `idx_workouts_day` ON `workouts` (`day`);
--> statement-breakpoint
INSERT INTO `device_settings` (`key`, `value`)
  SELECT `key`, `value` FROM `settings` WHERE `key` IN (
    'models_cache', 'models_cache_at',
    'health_connect_last_sync_at', 'health_connect_history_synced', 'health_connect_resync_version',
    'garmin_last_sync_at', 'garmin_display_name', 'garmin_activities_backfilled',
    'garmin_wellness_through', 'garmin_wellness_back_to', 'garmin_paused_until',
    'coach_morning_hour', 'coach_prompt_prefix', 'coach_unread_chat'
  );--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN (SELECT `key` FROM `device_settings`);--> statement-breakpoint
UPDATE `device_settings`
  SET `value` = printf('00000000-0000-7000-8000-%012x', CAST(`value` AS INTEGER))
  WHERE `key` = 'coach_unread_chat' AND `value` GLOB '[0-9]*';--> statement-breakpoint
UPDATE `entry_messages`
  SET `before_entry` = json_set(`before_entry`, '$.id',
    printf('00000000-0000-7000-8000-%012x', json_extract(`before_entry`, '$.id')))
  WHERE `before_entry` IS NOT NULL AND json_type(`before_entry`, '$.id') = 'integer';
