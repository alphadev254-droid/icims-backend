ALTER TABLE `events`
  ADD COLUMN `recordType` VARCHAR(191) NOT NULL DEFAULT 'direct',
  ADD COLUMN `sourceEventId` VARCHAR(191) NULL,
  ADD COLUMN `scheduledOccurrenceId` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `events_scheduledOccurrenceId_key` ON `events`(`scheduledOccurrenceId`);
CREATE INDEX `events_recordType_idx` ON `events`(`recordType`);
CREATE INDEX `events_sourceEventId_idx` ON `events`(`sourceEventId`);

UPDATE `events` e
JOIN `scheduled_events` se ON se.`sourceModule` = 'events' AND se.`sourceId` = e.`id`
SET e.`recordType` = 'scheduled_source'
WHERE e.`recordType` = 'direct' AND se.`status` = 'scheduled';
