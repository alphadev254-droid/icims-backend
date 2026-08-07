ALTER TABLE `event_tickets`
  ADD COLUMN `churchId` VARCHAR(191) NULL;

ALTER TABLE `attendance_participants`
  ADD COLUMN `sourceChurchId` VARCHAR(191) NULL,
  ADD COLUMN `eventTicketId` VARCHAR(191) NULL;

UPDATE `event_tickets` AS `ticket`
JOIN `events` AS `event` ON `event`.`id` = `ticket`.`eventId`
SET `ticket`.`churchId` = `event`.`churchId`
WHERE `ticket`.`churchId` IS NULL;

UPDATE `attendance_participants` AS `participant`
JOIN `attendance` AS `record` ON `record`.`id` = `participant`.`attendanceId`
SET `participant`.`sourceChurchId` = `record`.`churchId`
WHERE `participant`.`sourceChurchId` IS NULL;

CREATE INDEX `event_tickets_churchId_idx` ON `event_tickets`(`churchId`);
CREATE INDEX `attendance_participants_sourceChurchId_idx` ON `attendance_participants`(`sourceChurchId`);
CREATE UNIQUE INDEX `attendance_participants_eventTicketId_key` ON `attendance_participants`(`eventTicketId`);

ALTER TABLE `event_tickets`
  ADD CONSTRAINT `event_tickets_churchId_fkey`
  FOREIGN KEY (`churchId`) REFERENCES `churches`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `attendance_participants`
  ADD CONSTRAINT `attendance_participants_sourceChurchId_fkey`
  FOREIGN KEY (`sourceChurchId`) REFERENCES `churches`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `attendance_participants_eventTicketId_fkey`
  FOREIGN KEY (`eventTicketId`) REFERENCES `event_tickets`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
