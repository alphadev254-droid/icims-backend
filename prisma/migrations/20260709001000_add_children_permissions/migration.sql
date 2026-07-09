-- Add dedicated children/dependents permissions and grant them to ministry admin.
-- Regional, district, and branch admins can receive these via the Roles page.

INSERT IGNORE INTO `permissions` (`id`, `name`, `resource`, `action`) VALUES
  ('perm_children_read', 'children:read', 'children', 'read'),
  ('perm_children_create', 'children:create', 'children', 'create'),
  ('perm_children_update', 'children:update', 'children', 'update'),
  ('perm_children_delete', 'children:delete', 'children', 'delete');

INSERT IGNORE INTO `role_permissions` (`ministryAdminId`, `roleId`, `permissionId`)
SELECT 'GLOBAL', r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`name` IN (
  'children:read',
  'children:create',
  'children:update',
  'children:delete'
)
WHERE r.`name` IN (
  'ministry_admin'
);
