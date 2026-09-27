ALTER TABLE `churches`
  ADD COLUMN `memberApprovalMode` VARCHAR(191) NOT NULL DEFAULT 'auto';

ALTER TABLE `users`
  ADD COLUMN `membershipApprovalStatus` VARCHAR(191) NOT NULL DEFAULT 'approved';

CREATE INDEX `users_membershipApprovalStatus_idx` ON `users`(`membershipApprovalStatus`);

INSERT IGNORE INTO `permissions` (`id`, `name`, `resource`, `action`) VALUES
  (UUID(), 'registration_requests:read', 'registration_requests', 'read'),
  (UUID(), 'registration_requests:approve', 'registration_requests', 'approve'),
  (UUID(), 'registration_requests:reject', 'registration_requests', 'reject');

INSERT IGNORE INTO `role_permissions` (`ministryAdminId`, `roleId`, `permissionId`)
SELECT 'GLOBAL', r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`name` IN (
  'registration_requests:read',
  'registration_requests:approve',
  'registration_requests:reject'
)
WHERE r.`name` = 'ministry_admin';
