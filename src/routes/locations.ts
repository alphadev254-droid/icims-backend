import { Router } from 'express';
import { getRegions, getDistricts, getTraditionalAuthorities, getVillages } from '../controllers/locationController';

const router = Router();

router.get('/regions', getRegions);
router.get('/districts/:region', getDistricts);
router.get('/traditional-authorities/:region/:district', getTraditionalAuthorities);
router.get('/villages/:region/:district/:traditionalAuthority', getVillages);

export default router;