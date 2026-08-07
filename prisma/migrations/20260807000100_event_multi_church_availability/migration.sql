ALTER TABLE `events`
  ADD COLUMN `scopeType` VARCHAR(191) NOT NULL DEFAULT 'one_church';

CREATE TABLE `event_churches` (
  `id` VARCHAR(191) NOT NULL,
  `eventId` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `event_churches_eventId_churchId_key`(`eventId`, `churchId`),
  INDEX `event_churches_churchId_idx`(`churchId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `event_churches` (`id`, `eventId`, `churchId`, `createdAt`)
SELECT CONCAT('evch_', SUBSTRING(REPLACE(UUID(), '-', ''), 1, 20)), `id`, `churchId`, NOW(3)
FROM `events`
WHERE `churchId` IS NOT NULL;

CREATE INDEX `events_scopeType_idx` ON `events`(`scopeType`);

ALTER TABLE `event_churches`
  ADD CONSTRAINT `event_churches_eventId_fkey`
  FOREIGN KEY (`eventId`) REFERENCES `events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `event_churches`
  ADD CONSTRAINT `event_churches_churchId_fkey`
  FOREIGN KEY (`churchId`) REFERENCES `churches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
