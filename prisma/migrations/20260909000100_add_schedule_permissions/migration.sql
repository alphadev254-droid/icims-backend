INSERT IGNORE INTO `permissions` (`id`, `name`, `resource`, `action`) VALUES
  (CONCAT('perm_', REPLACE(UUID(), '-', '')), 'schedules:read', 'schedules', 'read'),
  (CONCAT('perm_', REPLACE(UUID(), '-', '')), 'schedules:create', 'schedules', 'create'),
  (CONCAT('perm_', REPLACE(UUID(), '-', '')), 'schedules:update', 'schedules', 'update'),
  (CONCAT('perm_', REPLACE(UUID(), '-', '')), 'schedules:delete', 'schedules', 'delete');

INSERT IGNORE INTO `role_permissions` (`ministryAdminId`, `roleId`, `permissionId`)
SELECT 'GLOBAL', r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`name` IN (
  'schedules:read',
  'schedules:create',
  'schedules:update',
  'schedules:delete'
)
WHERE r.`name` = 'ministry_admin';
