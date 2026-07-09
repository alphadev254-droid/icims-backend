-- Keep existing roles consistent with the UI/API rule that page access requires read permission.
INSERT IGNORE INTO `role_permissions` (`ministryAdminId`, `roleId`, `permissionId`)
SELECT rp.`ministryAdminId`, rp.`roleId`, read_perm.`id`
FROM `role_permissions` rp
JOIN `permissions` selected_perm ON selected_perm.`id` = rp.`permissionId`
JOIN `permissions` read_perm
  ON read_perm.`resource` = selected_perm.`resource`
 AND read_perm.`action` = 'read'
WHERE selected_perm.`action` <> 'read'
  AND selected_perm.`name` NOT IN ('roles:manage', 'roles:assign', 'packages:view', 'packages:manage')
  AND selected_perm.`name` NOT LIKE 'packages:%'
  AND selected_perm.`name` NOT LIKE 'payments:%'
  AND selected_perm.`name` NOT LIKE 'system_payments:%';

-- Older users may have a role/church but no ministryAdminId. Custom roles and package
-- inheritance depend on that tenant link, so backfill it from the church when available.
UPDATE `users` u
JOIN `churches` c ON c.`id` = u.`churchId`
LEFT JOIN `roles` r ON r.`id` = u.`roleId`
SET u.`ministryAdminId` = c.`ministryAdminId`
WHERE u.`ministryAdminId` IS NULL
  AND c.`ministryAdminId` IS NOT NULL
  AND (r.`name` IS NULL OR r.`name` <> 'system_admin');
