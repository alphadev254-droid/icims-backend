import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { getRegions, getDistricts, getTraditionalAuthorities, getVillages, getPublicRegions, getPublicDistricts } from '../controllers/locationController';

const router = Router();

router.get('/public/regions', getPublicRegions);
router.get('/public/districts', getPublicDistricts);
router.get('/regions', authenticate, getRegions);
router.get('/districts/:region', authenticate, getDistricts);
router.get('/traditional-authorities/:region/:district', authenticate, getTraditionalAuthorities);
router.get('/villages/:region/:district/:traditionalAuthority', authenticate, getVillages);

export default router;
