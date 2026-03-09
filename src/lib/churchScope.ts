import prisma from './prisma';

/**
 * Returns churchIds accessible to a user based on their role + location scope.
 *
 * national_admin      → churches where nationalAdminId = userId
 * regional_leader     → churches where church.region IN user.regions  (["__all__"] = all)
 * district_overseer   → churches where church.district IN user.districts  (["__all__"] = all)
 * local_admin         → churches where church.traditionalAuthority IN user.traditionalAuthorities (["__all__"] = all)
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

  if (roleName === 'national_admin') {
    if (userId) {
      const churches = await prisma.church.findMany({ 
        where: { nationalAdminId: userId },
        select: { id: true } 
      });
      return churches.map(c => c.id);
    }
    // Fallback to all churches if no userId provided
    const churches = await prisma.church.findMany({ select: { id: true } });
    return churches.map(c => c.id);
  }

  // Get nationalAdminId for non-national_admin roles
  let nationalAdminId: string | null = null;
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { nationalAdminId: true },
    });
    nationalAdminId = user?.nationalAdminId || null;
  }

  if (roleName === 'regional_leader') {
    if (!regions || regions.length === 0) return churchId ? [churchId] : [];
    const whereClause: any = { region: { in: regions } };
    if (nationalAdminId) whereClause.nationalAdminId = nationalAdminId;
    
    if (regions.includes('__all__')) {
      const churches = await prisma.church.findMany({ 
        where: nationalAdminId ? { nationalAdminId } : {},
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

  if (roleName === 'district_overseer') {
    if (!districts || districts.length === 0) return churchId ? [churchId] : [];
    const whereClause: any = { district: { in: districts } };
    if (nationalAdminId) whereClause.nationalAdminId = nationalAdminId;
    
    if (districts.includes('__all__')) {
      const churches = await prisma.church.findMany({ 
        where: nationalAdminId ? { nationalAdminId } : {},
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

  if (roleName === 'local_admin') {
    if (!traditionalAuthorities || traditionalAuthorities.length === 0) return churchId ? [churchId] : [];
    const whereClause: any = { traditionalAuthority: { in: traditionalAuthorities } };
    if (nationalAdminId) whereClause.nationalAdminId = nationalAdminId;
    
    if (traditionalAuthorities.includes('__all__')) {
      const churches = await prisma.church.findMany({ 
        where: nationalAdminId ? { nationalAdminId } : {},
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
