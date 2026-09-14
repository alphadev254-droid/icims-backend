ALTER TABLE `events`
  ADD COLUMN `publicationStatus` VARCHAR(191) NOT NULL DEFAULT 'published',
  ADD COLUMN `publishAt` DATETIME(3) NULL,
  ADD COLUMN `publishedAt` DATETIME(3) NULL;

ALTER TABLE `cell_meetings`
  ADD COLUMN `publicationStatus` VARCHAR(191) NOT NULL DEFAULT 'published',
  ADD COLUMN `publishAt` DATETIME(3) NULL,
  ADD COLUMN `publishedAt` DATETIME(3) NULL;

ALTER TABLE `announcements`
  ADD COLUMN `publicationStatus` VARCHAR(191) NOT NULL DEFAULT 'published',
  ADD COLUMN `publishedAt` DATETIME(3) NULL;

ALTER TABLE `team_communications`
  ADD COLUMN `publicationStatus` VARCHAR(191) NOT NULL DEFAULT 'published',
  ADD COLUMN `publishedAt` DATETIME(3) NULL;

UPDATE `events` SET `publishedAt` = `createdAt` WHERE `publicationStatus` = 'published';
UPDATE `cell_meetings` SET `publishedAt` = `createdAt` WHERE `publicationStatus` = 'published';
UPDATE `announcements` SET `publishedAt` = `createdAt` WHERE `publicationStatus` = 'published';
UPDATE `team_communications` SET `publishedAt` = `createdAt` WHERE `publicationStatus` = 'published';

UPDATE `announcements` a
JOIN `scheduled_events` se ON se.`sourceModule` = 'announcements' AND se.`sourceId` = a.`id`
SET a.`publicationStatus` = 'draft', a.`publishedAt` = NULL
WHERE se.`status` = 'scheduled' AND se.`startAt` > NOW(3);

UPDATE `team_communications` tc
JOIN `scheduled_events` se ON se.`sourceModule` = 'team_communications' AND se.`sourceId` = tc.`id`
SET tc.`publicationStatus` = 'draft', tc.`publishedAt` = NULL
WHERE se.`status` = 'scheduled' AND se.`startAt` > NOW(3);

UPDATE `events` e
JOIN `scheduled_events` se ON se.`sourceModule` = 'events' AND se.`sourceId` = e.`id`
SET e.`publishAt` = DATE_SUB(se.`startAt`, INTERVAL 30 DAY),
    e.`publicationStatus` = IF(DATE_SUB(se.`startAt`, INTERVAL 30 DAY) > NOW(3), 'draft', 'published'),
    e.`publishedAt` = IF(DATE_SUB(se.`startAt`, INTERVAL 30 DAY) > NOW(3), NULL, e.`publishedAt`)
WHERE se.`status` = 'scheduled';

UPDATE `cell_meetings` cm
JOIN `scheduled_events` se ON se.`sourceModule` = 'cell_meetings' AND se.`sourceId` = cm.`id`
SET cm.`publishAt` = DATE_SUB(se.`startAt`, INTERVAL 30 DAY),
    cm.`publicationStatus` = IF(DATE_SUB(se.`startAt`, INTERVAL 30 DAY) > NOW(3), 'draft', 'published'),
    cm.`publishedAt` = IF(DATE_SUB(se.`startAt`, INTERVAL 30 DAY) > NOW(3), NULL, cm.`publishedAt`)
WHERE se.`status` = 'scheduled';

CREATE INDEX `events_publicationStatus_publishAt_idx` ON `events`(`publicationStatus`, `publishAt`);
CREATE INDEX `cell_meetings_publicationStatus_publishAt_idx` ON `cell_meetings`(`publicationStatus`, `publishAt`);
