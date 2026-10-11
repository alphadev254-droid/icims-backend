CREATE TABLE `program_notifications` (
  `id` VARCHAR(191) NOT NULL,
  `programId` VARCHAR(191) NOT NULL,
  `itemId` VARCHAR(191) NOT NULL,
  `targetType` VARCHAR(191) NOT NULL,
  `targetId` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(191) NOT NULL,
  `recipient` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `itemTitle` VARCHAR(191) NOT NULL,
  `startsAt` DATETIME(3) NOT NULL,
  `endsAt` DATETIME(3) NOT NULL,
  `fingerprint` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'queued',
  `error` TEXT NULL,
  `sentAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `program_notifications_programId_createdAt_idx` (`programId`, `createdAt`),
  INDEX `program_notifications_itemId_createdAt_idx` (`itemId`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `permissions` (`id`, `name`, `resource`, `action`) VALUES
  (CONCAT('perm_', REPLACE(UUID(), '-', '')), 'programs:read', 'programs', 'read'),
  (CONCAT('perm_', REPLACE(UUID(), '-', '')), 'programs:manage', 'programs', 'manage'),
  (CONCAT('perm_', REPLACE(UUID(), '-', '')), 'programs:send', 'programs', 'send');

INSERT IGNORE INTO `role_permissions` (`ministryAdminId`, `roleId`, `permissionId`)
SELECT 'GLOBAL', r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`name` IN ('programs:read', 'programs:manage', 'programs:send')
WHERE r.`name` = 'ministry_admin';

-- Keep existing program access for roles that could already view or edit
-- their parent event/attendance records. Sending remains opt-in.
INSERT IGNORE INTO `role_permissions` (`ministryAdminId`, `roleId`, `permissionId`)
SELECT DISTINCT rp.`ministryAdminId`, rp.`roleId`, programRead.`id`
FROM `role_permissions` rp
JOIN `permissions` parentPerm ON parentPerm.`id` = rp.`permissionId`
JOIN `permissions` programRead ON programRead.`name` = 'programs:read'
WHERE parentPerm.`name` IN ('events:read', 'attendance:read');

INSERT IGNORE INTO `role_permissions` (`ministryAdminId`, `roleId`, `permissionId`)
SELECT DISTINCT rp.`ministryAdminId`, rp.`roleId`, programManage.`id`
FROM `role_permissions` rp
JOIN `permissions` parentPerm ON parentPerm.`id` = rp.`permissionId`
JOIN `permissions` programManage ON programManage.`name` = 'programs:manage'
WHERE parentPerm.`name` IN ('events:update', 'attendance:update');
