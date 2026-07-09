-- Create children/dependents records and guardian links.

CREATE TABLE `children` (
  `id` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `firstName` VARCHAR(191) NOT NULL,
  `lastName` VARCHAR(191) NOT NULL,
  `dateOfBirth` DATETIME(3) NULL,
  `age` INTEGER NULL,
  `gender` VARCHAR(191) NULL,
  `phone` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'active',
  `notes` TEXT NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `children_churchId_idx`(`churchId`),
  INDEX `children_status_idx`(`status`),
  INDEX `children_createdById_idx`(`createdById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `child_guardians` (
  `id` VARCHAR(191) NOT NULL,
  `childId` VARCHAR(191) NOT NULL,
  `guardianId` VARCHAR(191) NOT NULL,
  `relationship` VARCHAR(191) NOT NULL DEFAULT 'guardian',
  `isPrimary` BOOLEAN NOT NULL DEFAULT false,
  `canPickup` BOOLEAN NOT NULL DEFAULT true,
  `emergencyContact` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `child_guardians_childId_guardianId_key`(`childId`, `guardianId`),
  INDEX `child_guardians_guardianId_idx`(`guardianId`),
  INDEX `child_guardians_childId_idx`(`childId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `children`
  ADD CONSTRAINT `children_churchId_fkey`
  FOREIGN KEY (`churchId`) REFERENCES `churches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `children`
  ADD CONSTRAINT `children_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `child_guardians`
  ADD CONSTRAINT `child_guardians_childId_fkey`
  FOREIGN KEY (`childId`) REFERENCES `children`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `child_guardians`
  ADD CONSTRAINT `child_guardians_guardianId_fkey`
  FOREIGN KEY (`guardianId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
