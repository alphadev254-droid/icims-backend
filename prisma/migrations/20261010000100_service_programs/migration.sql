CREATE TABLE `services` (
  `id` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `type` VARCHAR(191) NULL,
  `startsAt` DATETIME(3) NOT NULL,
  `endsAt` DATETIME(3) NULL,
  `location` VARCHAR(191) NULL,
  `description` TEXT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'scheduled',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `services_churchId_startsAt_idx` (`churchId`, `startsAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `programs` (
  `id` VARCHAR(191) NOT NULL,
  `serviceId` VARCHAR(191) NULL,
  `eventId` VARCHAR(191) NULL,
  `title` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `programs_serviceId_key` (`serviceId`),
  UNIQUE INDEX `programs_eventId_key` (`eventId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `program_items` (
  `id` VARCHAR(191) NOT NULL,
  `programId` VARCHAR(191) NOT NULL,
  `position` INTEGER NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `startsAt` DATETIME(3) NOT NULL,
  `endsAt` DATETIME(3) NOT NULL,
  `userId` VARCHAR(191) NULL,
  `guestName` VARCHAR(191) NULL,
  `guestEmail` VARCHAR(191) NULL,
  `guestPhone` VARCHAR(191) NULL,
  INDEX `program_items_programId_position_idx` (`programId`, `position`),
  INDEX `program_items_userId_idx` (`userId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `attendance` ADD COLUMN `serviceId` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `attendance_serviceId_key` ON `attendance`(`serviceId`);

ALTER TABLE `services` ADD CONSTRAINT `services_churchId_fkey` FOREIGN KEY (`churchId`) REFERENCES `churches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `programs` ADD CONSTRAINT `programs_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `services`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `programs` ADD CONSTRAINT `programs_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `program_items` ADD CONSTRAINT `program_items_programId_fkey` FOREIGN KEY (`programId`) REFERENCES `programs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `program_items` ADD CONSTRAINT `program_items_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `attendance` ADD CONSTRAINT `attendance_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `services`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
