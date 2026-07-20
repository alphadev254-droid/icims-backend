import prisma from './prisma';

const activeChurchWhere = { status: 'active' };

function parseList(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Returns active church IDs accessible to a user.
 *
 * ministry_admin uses all active churches in their ministry.
 * Tenant/custom roles use RoleScope.
 * members use only their own church.
 */
export async function getAccessibleChurchIds(
  roleName: string,
  churchId: string | null | undefined,
  districts?: string[],
  traditionalAuthorities?: string[],
  regions?: string[],
  userId?: string,
): Promise<string[]> {

  if (roleName === 'ministry_admin') {
    if (userId) {
      const churches = await prisma.church.findMany({ 
        where: { ministryAdminId: userId, ...activeChurchWhere },
        select: { id: true } 
      });
      return churches.map(c => c.id);
    }
    // Fallback to all churches if no userId provided
    const churches = await prisma.church.findMany({ where: activeChurchWhere, select: { id: true } });
    return churches.map(c => c.id);
  }

  // Get ministryAdminId for non-ministry_admin roles
  let ministryAdminId: string | null = null;
  let customRoleScope: any = null;
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        ministryAdminId: true,
        churchId: true,
        role: { include: { scope: true } },
        church: { select: { ministryAdminId: true } },
      },
    });
    ministryAdminId = user?.ministryAdminId || user?.church?.ministryAdminId || null;
    if (user?.role?.ministryAdminId && user.role.scope) {
      customRoleScope = user.role.scope;
    }
  }

  if (customRoleScope && ministryAdminId) {
    if (customRoleScope.scopeType === 'own_church') {
      return churchId ? [churchId] : [];
    }

    if (customRoleScope.scopeType === 'all_ministry') {
      const churches = await prisma.church.findMany({
        where: { ministryAdminId, ...activeChurchWhere },
        select: { id: true },
      });
      return churches.map(c => c.id);
    }

    if (customRoleScope.scopeType === 'specific_churches') {
      const ids = parseList(customRoleScope.churchIds);
      if (ids.length === 0) return [];
      const churches = await prisma.church.findMany({
        where: { id: { in: ids }, ministryAdminId, ...activeChurchWhere },
        select: { id: true },
      });
      return churches.map(c => c.id);
    }

    if (customRoleScope.scopeType === 'regions') {
      const values = parseList(customRoleScope.regions);
      if (values.length === 0) return [];
      const churches = await prisma.church.findMany({
        where: { ministryAdminId, region: { in: values }, ...activeChurchWhere },
        select: { id: true },
      });
      return churches.map(c => c.id);
    }

    if (customRoleScope.scopeType === 'districts') {
      const values = parseList(customRoleScope.districts);
      if (values.length === 0) return [];
      const churches = await prisma.church.findMany({
        where: { ministryAdminId, district: { in: values }, ...activeChurchWhere },
        select: { id: true },
      });
      return churches.map(c => c.id);
    }

    if (customRoleScope.scopeType === 'traditional_authorities') {
      const values = parseList(customRoleScope.traditionalAuthorities);
      if (values.length === 0) return [];
      const churches = await prisma.church.findMany({
        where: { ministryAdminId, traditionalAuthority: { in: values }, ...activeChurchWhere },
        select: { id: true },
      });
      return churches.map(c => c.id);
    }
  }

  // member or unknown role → own church only
  if (!churchId) return [];
  const church = await prisma.church.findFirst({ where: { id: churchId, ...activeChurchWhere }, select: { id: true } });
  return church ? [church.id] : [];
}
