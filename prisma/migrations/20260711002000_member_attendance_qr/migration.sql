ALTER TABLE `users`
  ADD COLUMN `attendanceQrToken` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `users_attendanceQrToken_key` ON `users`(`attendanceQrToken`);
CREATE INDEX `users_attendanceQrToken_idx` ON `users`(`attendanceQrToken`);
