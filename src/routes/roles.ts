import { Router } from 'express';
import { assignRole, createRole, deleteRole, getAllPermissions, getRoles, updateRole, updateRolePermissions } from '../controllers/rolesController';
import { authenticate, authorizePermission } from '../middleware/auth';

const router = Router();

router.use(authenticate);

// List all roles for current church (with their permissions + user counts)
router.get('/', authorizePermission('roles:read'), getRoles);

// List all available permission definitions
router.get('/permissions', authorizePermission('roles:read'), getAllPermissions);

// Create/update/delete ministry-owned custom roles
router.post('/', authorizePermission('roles:manage'), createRole);
router.put('/:id', authorizePermission('roles:manage'), updateRole);
router.delete('/:id', authorizePermission('roles:manage'), deleteRole);

// Update which permissions a role has (transfer/assign power)
router.put('/:id/permissions', authorizePermission('roles:manage'), updateRolePermissions);

// Assign a role to a user
router.post('/assign', authorizePermission('roles:assign'), assignRole);

export default router;
