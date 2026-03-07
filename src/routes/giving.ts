import { Router } from 'express';
import { authenticate, authorizePermission } from '../middleware/auth';
import * as givingController from '../controllers/givingController';

const router = Router();

// Campaigns
router.post('/campaigns', authenticate, authorizePermission('campaigns:create'), givingController.createCampaign);
router.get('/campaigns', authenticate, authorizePermission('campaigns:read'), givingController.getCampaigns);
router.get('/campaigns/:id', authenticate, authorizePermission('campaigns:read'), givingController.getCampaign);
router.put('/campaigns/:id', authenticate, authorizePermission('campaigns:update'), givingController.updateCampaign);
router.delete('/campaigns/:id', authenticate, authorizePermission('campaigns:delete'), givingController.deleteCampaign);

// Donations
router.post('/donate', authenticate, authorizePermission('donations:create'), givingController.createDonation);
router.get('/donations', authenticate, authorizePermission('donations:read'), givingController.getDonations);
router.get('/donations/:id/transaction', authenticate, authorizePermission('donations:read'), givingController.getDonationTransaction);

export default router;
