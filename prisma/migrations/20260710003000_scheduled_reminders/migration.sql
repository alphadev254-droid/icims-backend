CREATE TABLE `scheduled_reminders` (
  `id` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `campaignId` VARCHAR(191) NULL,
  `type` VARCHAR(191) NOT NULL,
  `audience` VARCHAR(191) NOT NULL,
  `channelEmail` BOOLEAN NOT NULL DEFAULT true,
  `channelPush` BOOLEAN NOT NULL DEFAULT true,
  `title` VARCHAR(191) NOT NULL,
  `message` TEXT NOT NULL,
  `scheduleKind` VARCHAR(191) NOT NULL,
  `scheduleDays` TEXT NULL,
  `deadlineOffsets` TEXT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdById` VARCHAR(191) NULL,
  `lastRunAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `scheduled_reminders_churchId_idx` (`churchId`),
  INDEX `scheduled_reminders_ministryAdminId_idx` (`ministryAdminId`),
  INDEX `scheduled_reminders_campaignId_idx` (`campaignId`),
  INDEX `scheduled_reminders_type_idx` (`type`),
  INDEX `scheduled_reminders_isActive_idx` (`isActive`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `scheduled_reminder_logs` (
  `id` VARCHAR(191) NOT NULL,
  `reminderId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NULL,
  `recipientEmail` VARCHAR(191) NULL,
  `channel` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL,
  `scheduledFor` DATETIME(3) NOT NULL,
  `sentAt` DATETIME(3) NULL,
  `error` TEXT NULL,
  `dedupeKey` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE INDEX `scheduled_reminder_logs_dedupeKey_key` (`dedupeKey`),
  INDEX `scheduled_reminder_logs_reminderId_idx` (`reminderId`),
  INDEX `scheduled_reminder_logs_userId_idx` (`userId`),
  INDEX `scheduled_reminder_logs_scheduledFor_idx` (`scheduledFor`),
  INDEX `scheduled_reminder_logs_status_idx` (`status`),
  CONSTRAINT `scheduled_reminder_logs_reminderId_fkey` FOREIGN KEY (`reminderId`) REFERENCES `scheduled_reminders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
