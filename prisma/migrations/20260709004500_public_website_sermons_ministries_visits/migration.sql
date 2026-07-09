CREATE TABLE `church_sermons` (
  `id` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `speaker` VARCHAR(191) NULL,
  `youtubeUrl` VARCHAR(191) NOT NULL,
  `series` VARCHAR(191) NULL,
  `duration` VARCHAR(191) NULL,
  `sermonDate` DATETIME(3) NULL,
  `description` TEXT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `church_sermons_ministryAdminId_isActive_sortOrder_idx`
  ON `church_sermons`(`ministryAdminId`, `isActive`, `sortOrder`);

CREATE TABLE `church_ministries` (
  `id` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` TEXT NOT NULL,
  `imageUrl` VARCHAR(191) NULL,
  `icon` VARCHAR(191) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `church_ministries_ministryAdminId_isActive_sortOrder_idx`
  ON `church_ministries`(`ministryAdminId`, `isActive`, `sortOrder`);

CREATE TABLE `visit_requests` (
  `id` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `firstName` VARCHAR(191) NOT NULL,
  `lastName` VARCHAR(191) NOT NULL,
  `email` VARCHAR(191) NOT NULL,
  `phone` VARCHAR(191) NULL,
  `serviceName` VARCHAR(191) NULL,
  `notes` TEXT NULL,
  `sourceSlug` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'new',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `visit_requests_ministryAdminId_createdAt_idx`
  ON `visit_requests`(`ministryAdminId`, `createdAt`);
