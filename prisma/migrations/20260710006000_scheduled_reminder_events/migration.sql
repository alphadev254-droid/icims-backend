ALTER TABLE `scheduled_reminders`
  ADD COLUMN `eventId` VARCHAR(191) NULL;

CREATE INDEX `scheduled_reminders_eventId_idx` ON `scheduled_reminders`(`eventId`);
