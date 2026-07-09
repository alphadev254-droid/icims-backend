import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { authenticate } from '../middleware/auth';
import { uploadImage } from '../middleware/upload';
import {
  getMyProfile,
  updateMyProfile,
  getPublicProfile,
  submitVisitRequest,
  listWebsiteSermons,
  createWebsiteSermon,
  updateWebsiteSermon,
  deleteWebsiteSermon,
  listWebsiteMinistries,
  createWebsiteMinistry,
  updateWebsiteMinistry,
  deleteWebsiteMinistry,
} from '../controllers/churchProfileController';
import prisma from '../lib/prisma';

const router = Router();

// ─── Public — no auth ─────────────────────────────────────────────────────────
router.post('/p/:slug/visit', submitVisitRequest);
router.get('/p/:slug', getPublicProfile);

// ─── Protected — ministry_admin ───────────────────────────────────────────────
router.get('/church-profile', authenticate, getMyProfile);
router.put('/church-profile', authenticate, updateMyProfile);
router.get('/church-profile/sermons', authenticate, listWebsiteSermons);
router.post('/church-profile/sermons', authenticate, createWebsiteSermon);
router.put('/church-profile/sermons/:id', authenticate, updateWebsiteSermon);
router.delete('/church-profile/sermons/:id', authenticate, deleteWebsiteSermon);
router.get('/church-profile/ministries', authenticate, listWebsiteMinistries);
router.post('/church-profile/ministries', authenticate, createWebsiteMinistry);
router.put('/church-profile/ministries/:id', authenticate, updateWebsiteMinistry);
router.delete('/church-profile/ministries/:id', authenticate, deleteWebsiteMinistry);

// Upload logo
router.post(
  '/church-profile/upload/logo',
  authenticate,
  (req, _res, next) => { (req as any).uploadSubDir = 'church-profiles'; next(); },
  uploadImage.single('image'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.userId;
    if (!req.file) { res.status(400).json({ success: false, message: 'No file uploaded' }); return; }

    const url = `/uploads/church-profiles/${req.file.filename}`;

    // Delete old logo file if it was a local upload
    const existing = await prisma.churchProfile.findUnique({ where: { ministryAdminId: userId! }, select: { logoUrl: true } });
    if (existing?.logoUrl?.startsWith('/uploads/')) {
      const oldPath = path.join(process.cwd(), existing.logoUrl.replace(/^\//, ''));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    // Persist to profile
    await prisma.churchProfile.upsert({
      where: { ministryAdminId: userId! },
      update: { logoUrl: url },
      create: { ministryAdminId: userId!, logoUrl: url },
    });

    res.json({ success: true, url });
  }
);

// Upload banner
router.post(
  '/church-profile/upload/banner',
  authenticate,
  (req, _res, next) => { (req as any).uploadSubDir = 'church-profiles'; next(); },
  uploadImage.single('image'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.userId;
    if (!req.file) { res.status(400).json({ success: false, message: 'No file uploaded' }); return; }

    const url = `/uploads/church-profiles/${req.file.filename}`;

    // Delete old banner file if it was a local upload
    const existing = await prisma.churchProfile.findUnique({ where: { ministryAdminId: userId! }, select: { bannerUrl: true } });
    if (existing?.bannerUrl?.startsWith('/uploads/')) {
      const oldPath = path.join(process.cwd(), existing.bannerUrl.replace(/^\//, ''));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    await prisma.churchProfile.upsert({
      where: { ministryAdminId: userId! },
      update: { bannerUrl: url },
      create: { ministryAdminId: userId!, bannerUrl: url },
    });

    res.json({ success: true, url });
  }
);

// Upload pastor photo
router.post(
  '/church-profile/upload/pastor',
  authenticate,
  (req, _res, next) => { (req as any).uploadSubDir = 'church-profiles'; next(); },
  uploadImage.single('image'),
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.userId;
    if (!req.file) { res.status(400).json({ success: false, message: 'No file uploaded' }); return; }

    const url = `/uploads/church-profiles/${req.file.filename}`;

    const existing = await prisma.churchProfile.findUnique({ where: { ministryAdminId: userId! }, select: { pastorPhoto: true } });
    if (existing?.pastorPhoto?.startsWith('/uploads/')) {
      const oldPath = path.join(process.cwd(), existing.pastorPhoto.replace(/^\//, ''));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    await prisma.churchProfile.upsert({
      where: { ministryAdminId: userId! },
      update: { pastorPhoto: url },
      create: { ministryAdminId: userId!, pastorPhoto: url },
    });

    res.json({ success: true, url });
  }
);

// Remove logo, banner, or pastor photo
router.delete(
  '/church-profile/upload/:type',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.userId;
    const type = String(req.params.type);
    if (!['logo', 'banner', 'pastor'].includes(type)) {
      res.status(400).json({ success: false, message: 'Invalid type' }); return;
    }

    const fieldMap: Record<string, string> = { logo: 'logoUrl', banner: 'bannerUrl', pastor: 'pastorPhoto' };
    const field = fieldMap[type];
    const existing = await prisma.churchProfile.findUnique({ where: { ministryAdminId: userId! }, select: { [field]: true } as any });
    const oldUrl: string | null = (existing as any)?.[field] ?? null;

    if (oldUrl?.startsWith('/uploads/')) {
      const oldPath = path.join(process.cwd(), oldUrl.replace(/^\//, ''));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    await prisma.churchProfile.upsert({
      where: { ministryAdminId: userId! },
      update: { [field]: null },
      create: { ministryAdminId: userId!, [field]: null },
    });

    res.json({ success: true });
  }
);

export default router;
