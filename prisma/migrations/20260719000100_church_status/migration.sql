ALTER TABLE `churches`
  ADD COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'active';

CREATE INDEX `churches_ministryAdminId_status_idx` ON `churches`(`ministryAdminId`, `status`);
CREATE INDEX `churches_status_idx` ON `churches`(`status`);
