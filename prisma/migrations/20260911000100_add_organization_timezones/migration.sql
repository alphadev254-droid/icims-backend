ALTER TABLE `users` ADD COLUMN `timezone` VARCHAR(191) NULL;
ALTER TABLE `churches` ADD COLUMN `timezone` VARCHAR(191) NULL;

UPDATE `users`
SET `timezone` = CASE
  WHEN LOWER(`account_country`) = 'kenya' THEN 'Africa/Nairobi'
  WHEN LOWER(`account_country`) = 'malawi' THEN 'Africa/Blantyre'
  ELSE NULL
END
WHERE `timezone` IS NULL;

UPDATE `churches`
SET `timezone` = CASE
  WHEN LOWER(`country`) = 'kenya' THEN 'Africa/Nairobi'
  WHEN LOWER(`country`) = 'malawi' THEN 'Africa/Blantyre'
  ELSE NULL
END
WHERE `timezone` IS NULL;

UPDATE `scheduled_events` se
JOIN `churches` c ON c.id = se.churchId
SET se.timezone = c.timezone
WHERE se.timezone = 'UTC' AND c.timezone IS NOT NULL;

CREATE INDEX `scheduled_events_source_status_start_idx`
  ON `scheduled_events`(`sourceModule`, `status`, `startAt`);

CREATE INDEX `scheduled_event_occ_status_start_idx`
  ON `scheduled_event_occurrences`(`status`, `occurrenceStartAt`);
