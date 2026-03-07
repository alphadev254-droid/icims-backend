import prisma from '../lib/prisma';

/**
 * Check for expired subscriptions and mark them as expired
 * Runs every 24 hours via cron job
 */
export async function checkExpiredSubscriptions() {
  console.log('[Subscription Worker] Starting expired subscription check...');
  
  try {
    const now = new Date();
    
    // Find all active subscriptions that have expired
    const expiredSubscriptions = await prisma.subscription.updateMany({
      where: {
        status: 'active',
        expiresAt: { lt: now },
      },
      data: {
        status: 'expired',
      },
    });

    console.log(`[Subscription Worker] Marked ${expiredSubscriptions.count} subscriptions as expired`);
  } catch (error) {
    console.error('[Subscription Worker] Fatal error:', error);
  }
}

/**
 * Check for subscriptions expiring soon (7 days) and send reminder emails
 */
export async function checkExpiringSubscriptions() {
  console.log('[Subscription Worker] Checking for expiring subscriptions...');
  
  try {
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    
    const expiringSubscriptions = await prisma.subscription.findMany({
      where: {
        status: 'active',
        expiresAt: {
          gte: now,
          lte: sevenDaysFromNow,
        },
      },
      include: {
        package: true,
      },
    });

    console.log(`[Subscription Worker] Found ${expiringSubscriptions.length} subscriptions expiring within 7 days`);

    for (const subscription of expiringSubscriptions) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: subscription.nationalAdminId },
        });

        if (user && user.email) {
          console.log(`[Subscription Worker] Reminder: ${user.email} subscription expires on ${subscription.expiresAt}`);
          
          // TODO: Send reminder email
          // await emailQueue.add({ type: 'subscription_expiring', userId: user.id, expiresAt: subscription.expiresAt })
        }
      } catch (error) {
        console.error(`[Subscription Worker] Error processing reminder for subscription ${subscription.id}:`, error);
      }
    }

    console.log('[Subscription Worker] Expiring subscriptions check completed.');
  } catch (error) {
    console.error('[Subscription Worker] Fatal error:', error);
  }
}

// Run both checks
export async function runSubscriptionChecks() {
  await checkExpiredSubscriptions();
  await checkExpiringSubscriptions();
}

// If running directly
if (require.main === module) {
  runSubscriptionChecks()
    .then(() => {
      console.log('[Subscription Worker] All checks completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[Subscription Worker] Failed:', error);
      process.exit(1);
    });
}
