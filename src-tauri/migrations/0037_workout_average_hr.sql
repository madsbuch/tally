ALTER TABLE `workouts` ADD `avg_hr` real;--> statement-breakpoint
-- Prefer the exact measured Garmin average over the rounded description.
UPDATE `workouts`
SET `avg_hr` = (
  SELECT `avg_hr` FROM `garmin_activities`
  WHERE `workout_id` = `workouts`.`id` AND `avg_hr` > 0
  ORDER BY `updated_at` DESC LIMIT 1
);--> statement-breakpoint
-- Older syncs kept Health Connect HR only in this generated description tail.
-- Accept that exact integer format, never arbitrary numbers in diary notes.
WITH recorded_hr AS (
  SELECT `id`, substr(`description`, instr(`description`, ' · avg HR ') + 10) AS hr
  FROM `workouts`
  WHERE `avg_hr` IS NULL AND `source` IS NOT NULL
    AND instr(`description`, ' · avg HR ') > 0
)
UPDATE `workouts`
SET `avg_hr` = (
  SELECT CAST(hr AS REAL) FROM recorded_hr WHERE recorded_hr.id = `workouts`.`id`
)
WHERE `id` IN (
  SELECT `id` FROM recorded_hr
  WHERE hr <> '' AND hr NOT GLOB '*[^0-9]*' AND CAST(hr AS REAL) > 0
);--> statement-breakpoint
-- Replace automatic Zone 2 classification, preserving the user's on/off choices.
UPDATE `workouts`
SET `cardio` = CASE WHEN `avg_hr` > 125 THEN 1 ELSE 0 END
WHERE `cardio_by_hand` = 0;
