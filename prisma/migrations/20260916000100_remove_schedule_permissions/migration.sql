DELETE rp
FROM role_permissions rp
INNER JOIN permissions p ON p.id = rp.permissionId
WHERE p.name IN ('schedules:read', 'schedules:create', 'schedules:update', 'schedules:delete');

DELETE FROM permissions
WHERE name IN ('schedules:read', 'schedules:create', 'schedules:update', 'schedules:delete');
