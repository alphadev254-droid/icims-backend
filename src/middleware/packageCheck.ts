import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';

/**
 * Middleware to check if user's package includes a specific feature
 */
export function requirePackageFeature(featureName: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Not authenticated' });
      return;
    }

    // Get user with package and features
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        package: {
          include: {
            features: {
              include: { feature: true }
            }
          }
        }
      }
    });

    if (!user || !user.package) {
      res.status(403).json({ 
        success: false, 
        message: 'No package assigned to your account. Please contact support.' 
      });
      return;
    }

    // Check if package includes the required feature
    const hasFeature = user.package.features.some(
      pf => pf.feature.name === featureName
    );

    if (!hasFeature) {
      res.status(403).json({ 
        success: false, 
        message: `Your ${user.package.displayName} package does not include this feature. Please upgrade your package.` 
      });
      return;
    }

    next();
  };
}

/**
 * Middleware to check if user can create more churches based on package limits
 */
export async function checkChurchLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Not authenticated' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      package: true,
      ownedChurches: true
    }
  });

  if (!user || !user.package) {
    res.status(403).json({ 
      success: false, 
      message: 'No package assigned to your account' 
    });
    return;
  }

  if (user.ownedChurches.length >= user.package.maxChurches) {
    res.status(403).json({ 
      success: false, 
      message: `Your ${user.package.displayName} package allows maximum ${user.package.maxChurches} churches. Upgrade to create more.` 
    });
    return;
  }

  next();
}