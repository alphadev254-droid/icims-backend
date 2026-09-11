ALTER TABLE `cell_meetings`
  ADD COLUMN `recordType` VARCHAR(191) NOT NULL DEFAULT 'direct',
  ADD COLUMN `sourceMeetingId` VARCHAR(191) NULL,
  ADD COLUMN `scheduledOccurrenceId` VARCHAR(191) NULL;

UPDATE `cell_meetings` cm
JOIN `scheduled_events` se
  ON se.sourceModule = 'cell_meetings' AND se.sourceId = cm.id
SET cm.recordType = 'scheduled_source';

UPDATE `cell_meetings` cm
JOIN `scheduled_event_occurrences` seo
  ON seo.generatedSourceModule = 'cell_meetings' AND seo.generatedSourceId = cm.id
JOIN `scheduled_events` se ON se.id = seo.scheduledEventId
SET
  cm.recordType = IF(cm.id = se.sourceId, 'scheduled_source', 'scheduled_occurrence'),
  cm.sourceMeetingId = IF(cm.id = se.sourceId, NULL, se.sourceId),
  cm.scheduledOccurrenceId = seo.id
WHERE seo.status = 'generated';

CREATE UNIQUE INDEX `cell_meetings_scheduledOccurrenceId_key`
  ON `cell_meetings`(`scheduledOccurrenceId`);
CREATE INDEX `cell_meetings_recordType_idx` ON `cell_meetings`(`recordType`);
CREATE INDEX `cell_meetings_sourceMeetingId_idx` ON `cell_meetings`(`sourceMeetingId`);
