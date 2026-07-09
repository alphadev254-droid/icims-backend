-- Add ministry-owned custom roles and role-level data scopes.

ALTER TABLE `roles`
  ADD COLUMN `description` VARCHAR(191) NULL,
  ADD COLUMN `ministryAdminId` VARCHAR(191) NULL,
  ADD COLUMN `isSystemRole` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

CREATE INDEX `roles_ministryAdminId_idx` ON `roles`(`ministryAdminId`);

CREATE TABLE `role_scopes` (
  `id` VARCHAR(191) NOT NULL,
  `roleId` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `scopeType` VARCHAR(191) NOT NULL DEFAULT 'specific_churches',
  `churchIds` TEXT NULL,
  `regions` TEXT NULL,
  `districts` TEXT NULL,
  `traditionalAuthorities` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `role_scopes_roleId_key`(`roleId`),
  INDEX `role_scopes_ministryAdminId_idx`(`ministryAdminId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `role_scopes`
  ADD CONSTRAINT `role_scopes_roleId_fkey`
  FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
