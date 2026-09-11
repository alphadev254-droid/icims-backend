ALTER TABLE `events`
  ADD COLUMN `endTime` VARCHAR(191) NULL AFTER `time`;

UPDATE `events`
SET `endTime` = `time`
WHERE `endTime` IS NULL;
