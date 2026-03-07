import prisma from '../lib/prisma';

export async function getPaymentGateway(userId: string): Promise<'paystack' | 'paychangu'> {
  console.log(`[GATEWAY] Getting payment gateway for userId: ${userId}`);
  
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { accountCountry: true, nationalAdminId: true, churchId: true }
  });

  console.log(`[GATEWAY] User found:`, { accountCountry: user?.accountCountry, nationalAdminId: user?.nationalAdminId, churchId: user?.churchId });

  let country = user?.accountCountry;
  console.log(`[GATEWAY] Initial country from user: ${country}`);

  // For regional/district/local admins, get country from their national admin
  if (!country && user?.nationalAdminId) {
    console.log(`[GATEWAY] No country, checking nationalAdminId: ${user.nationalAdminId}`);
    const nationalAdmin = await prisma.user.findUnique({
      where: { id: user.nationalAdminId },
      select: { accountCountry: true }
    });
    country = nationalAdmin?.accountCountry;
    console.log(`[GATEWAY] Country from national admin: ${country}`);
  }

  // For members, get country from church's national admin
  if (!country && user?.churchId) {
    console.log(`[GATEWAY] No country, checking church: ${user.churchId}`);
    const church = await prisma.church.findUnique({
      where: { id: user.churchId },
      select: { nationalAdminId: true }
    });
    console.log(`[GATEWAY] Church nationalAdminId: ${church?.nationalAdminId}`);
    
    if (church?.nationalAdminId) {
      const nationalAdmin = await prisma.user.findUnique({
        where: { id: church.nationalAdminId },
        select: { accountCountry: true }
      });
      country = nationalAdmin?.accountCountry;
      console.log(`[GATEWAY] Country from church's national admin: ${country}`);
    }
  }

  const gateway = country === 'Malawi' ? 'paychangu' : 'paystack';
  console.log(`[GATEWAY] Final decision - Country: ${country}, Gateway: ${gateway}`);
  
  return gateway;
}

export function getCurrency(gateway: 'paystack' | 'paychangu'): string {
  return gateway === 'paychangu' ? 'MWK' : 'KSH';
}

export function getGatewayCountry(gateway: 'paystack' | 'paychangu'): string {
  return gateway === 'paychangu' ? 'Malawi' : 'Kenya';
}
