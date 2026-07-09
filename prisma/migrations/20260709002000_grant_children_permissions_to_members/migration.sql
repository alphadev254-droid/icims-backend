-- Allow members to access the Children page for their own linked children.
-- Backend controllers keep member access scoped to child_guardians.guardianId = current user.

INSERT IGNORE INTO `role_permissions` (`ministryAdminId`, `roleId`, `permissionId`)
SELECT 'GLOBAL', r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`name` IN (
  'children:read',
  'children:create',
  'children:update',
  'children:delete'
)
WHERE r.`name` = 'member';
