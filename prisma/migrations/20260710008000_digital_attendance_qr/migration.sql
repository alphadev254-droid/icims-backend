ALTER TABLE `attendance`
  ADD COLUMN `digitalCheckInEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `qrToken` VARCHAR(191) NULL,
  ADD COLUMN `qrStatus` VARCHAR(191) NOT NULL DEFAULT 'draft',
  ADD COLUMN `qrActiveFrom` DATETIME(3) NULL,
  ADD COLUMN `qrActiveUntil` DATETIME(3) NULL,
  ADD COLUMN `qrRegeneratedAt` DATETIME(3) NULL;

CREATE UNIQUE INDEX `attendance_qrToken_key` ON `attendance`(`qrToken`);
CREATE INDEX `attendance_qrStatus_idx` ON `attendance`(`qrStatus`);

CREATE TABLE `attendance_participants` (
  `id` VARCHAR(191) NOT NULL,
  `attendanceId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NULL,
  `guestName` VARCHAR(191) NULL,
  `guestEmail` VARCHAR(191) NULL,
  `guestPhone` VARCHAR(191) NULL,
  `guestFirstTime` BOOLEAN NOT NULL DEFAULT false,
  `invitedBy` VARCHAR(191) NULL,
  `checkInMethod` VARCHAR(191) NOT NULL DEFAULT 'qr_guest',
  `status` VARCHAR(191) NOT NULL DEFAULT 'present',
  `checkedInAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `attendance_participants_attendanceId_userId_key` ON `attendance_participants`(`attendanceId`, `userId`);
CREATE INDEX `attendance_participants_attendanceId_idx` ON `attendance_participants`(`attendanceId`);
CREATE INDEX `attendance_participants_userId_idx` ON `attendance_participants`(`userId`);
CREATE INDEX `attendance_participants_guestPhone_idx` ON `attendance_participants`(`guestPhone`);

ALTER TABLE `attendance_participants`
  ADD CONSTRAINT `attendance_participants_attendanceId_fkey`
  FOREIGN KEY (`attendanceId`) REFERENCES `attendance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `attendance_participants`
  ADD CONSTRAINT `attendance_participants_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
