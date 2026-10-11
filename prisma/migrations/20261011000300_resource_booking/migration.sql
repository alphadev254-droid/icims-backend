CREATE TABLE `bookable_resources` (
  `id` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `code` VARCHAR(191) NULL,
  `category` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `location` VARCHAR(191) NULL,
  `custodianName` VARCHAR(191) NULL,
  `scope` VARCHAR(191) NOT NULL DEFAULT 'own_church',
  `status` VARCHAR(191) NOT NULL DEFAULT 'active',
  `approvalRequired` BOOLEAN NOT NULL DEFAULT false,
  `bufferBeforeMinutes` INTEGER NOT NULL DEFAULT 0,
  `bufferAfterMinutes` INTEGER NOT NULL DEFAULT 0,
  `createdById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `bookable_resources_ministry_status_idx` (`ministryAdminId`, `status`),
  INDEX `bookable_resources_church_status_idx` (`churchId`, `status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `resource_bookings` (
  `id` VARCHAR(191) NOT NULL,
  `groupId` VARCHAR(191) NOT NULL,
  `resourceId` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `requesterId` VARCHAR(191) NOT NULL,
  `activityType` VARCHAR(191) NOT NULL DEFAULT 'manual',
  `activityId` VARCHAR(191) NULL,
  `activityTitle` VARCHAR(191) NOT NULL,
  `purpose` TEXT NULL,
  `startsAt` DATETIME(3) NOT NULL,
  `endsAt` DATETIME(3) NOT NULL,
  `blockedFrom` DATETIME(3) NOT NULL,
  `blockedUntil` DATETIME(3) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
  `decidedById` VARCHAR(191) NULL,
  `decidedAt` DATETIME(3) NULL,
  `decisionNote` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `resource_bookings_resource_interval_idx` (`resourceId`, `status`, `blockedFrom`, `blockedUntil`),
  INDEX `resource_bookings_ministry_start_idx` (`ministryAdminId`, `startsAt`),
  INDEX `resource_bookings_church_start_idx` (`churchId`, `startsAt`),
  INDEX `resource_bookings_requester_start_idx` (`requesterId`, `startsAt`),
  INDEX `resource_bookings_activity_idx` (`activityType`, `activityId`),
  INDEX `resource_bookings_group_idx` (`groupId`),
  CONSTRAINT `resource_bookings_resource_fkey` FOREIGN KEY (`resourceId`) REFERENCES `bookable_resources` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `resource_bookings_requester_fkey` FOREIGN KEY (`requesterId`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `resource_bookings_decider_fkey` FOREIGN KEY (`decidedById`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `permissions` (`id`, `name`, `resource`, `action`)
VALUES
  (UUID(), 'resource_booking:read', 'resource_booking', 'read'),
  (UUID(), 'resource_booking:request', 'resource_booking', 'request'),
  (UUID(), 'resource_booking:approve', 'resource_booking', 'approve'),
  (UUID(), 'resource_booking:manage', 'resource_booking', 'manage');

INSERT IGNORE INTO `role_permissions` (`ministryAdminId`, `roleId`, `permissionId`)
SELECT 'GLOBAL', r.`id`, p.`id` FROM `roles` r JOIN `permissions` p ON p.`resource` = 'resource_booking'
WHERE r.`name` = 'ministry_admin';
