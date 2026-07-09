import prisma from './prisma';

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
 * Returns churchIds accessible to a user based on their role + location scope.
 *
 * ministry_admin      → churches where ministryAdminId = userId
 * regional_admin     → churches where church.region IN user.regions  (["__all__"] = all)
 * district_admin   → churches where church.district IN user.districts  (["__all__"] = all)
 * branch_admin         → churches where church.traditionalAuthority IN user.traditionalAuthorities (["__all__"] = all)
 * member              → only their own churchId (if set)
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
        where: { ministryAdminId: userId },
        select: { id: true } 
      });
      return churches.map(c => c.id);
    }
    // Fallback to all churches if no userId provided
    const churches = await prisma.church.findMany({ select: { id: true } });
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
        where: { ministryAdminId },
        select: { id: true },
      });
      return churches.map(c => c.id);
    }

    if (customRoleScope.scopeType === 'specific_churches') {
      const ids = parseList(customRoleScope.churchIds);
      if (ids.length === 0) return [];
      const churches = await prisma.church.findMany({
        where: { id: { in: ids }, ministryAdminId },
        select: { id: true },
      });
      return churches.map(c => c.id);
    }

    if (customRoleScope.scopeType === 'regions') {
      const values = parseList(customRoleScope.regions);
      if (values.length === 0) return [];
      const churches = await prisma.church.findMany({
        where: { ministryAdminId, region: { in: values } },
        select: { id: true },
      });
      return churches.map(c => c.id);
    }

    if (customRoleScope.scopeType === 'districts') {
      const values = parseList(customRoleScope.districts);
      if (values.length === 0) return [];
      const churches = await prisma.church.findMany({
        where: { ministryAdminId, district: { in: values } },
        select: { id: true },
      });
      return churches.map(c => c.id);
    }

    if (customRoleScope.scopeType === 'traditional_authorities') {
      const values = parseList(customRoleScope.traditionalAuthorities);
      if (values.length === 0) return [];
      const churches = await prisma.church.findMany({
        where: { ministryAdminId, traditionalAuthority: { in: values } },
        select: { id: true },
      });
      return churches.map(c => c.id);
    }
  }

  if (roleName === 'regional_admin') {
    if (!regions || regions.length === 0) return churchId ? [churchId] : [];
    const whereClause: any = { region: { in: regions } };
    if (ministryAdminId) whereClause.ministryAdminId = ministryAdminId;
    
    if (regions.includes('__all__')) {
      const churches = await prisma.church.findMany({ 
        where: ministryAdminId ? { ministryAdminId } : {},
        select: { id: true } 
      });
      return churches.map(c => c.id);
    }
    const churches = await prisma.church.findMany({
      where: whereClause,
      select: { id: true },
    });
    return churches.map(c => c.id);
  }

  if (roleName === 'district_admin') {
    if (!districts || districts.length === 0) return churchId ? [churchId] : [];
    const whereClause: any = { district: { in: districts } };
    if (ministryAdminId) whereClause.ministryAdminId = ministryAdminId;
    
    if (districts.includes('__all__')) {
      const churches = await prisma.church.findMany({ 
        where: ministryAdminId ? { ministryAdminId } : {},
        select: { id: true } 
      });
      return churches.map(c => c.id);
    }
    const churches = await prisma.church.findMany({
      where: whereClause,
      select: { id: true },
    });
    return churches.map(c => c.id);
  }

  if (roleName === 'branch_admin') {
    if (!traditionalAuthorities || traditionalAuthorities.length === 0) return churchId ? [churchId] : [];
    const whereClause: any = { traditionalAuthority: { in: traditionalAuthorities } };
    if (ministryAdminId) whereClause.ministryAdminId = ministryAdminId;
    
    if (traditionalAuthorities.includes('__all__')) {
      const churches = await prisma.church.findMany({ 
        where: ministryAdminId ? { ministryAdminId } : {},
        select: { id: true } 
      });
      return churches.map(c => c.id);
    }
    const churches = await prisma.church.findMany({
      where: whereClause,
      select: { id: true },
    });
    return churches.map(c => c.id);
  }

  // member or unknown role → own church only
  return churchId ? [churchId] : [];
}
