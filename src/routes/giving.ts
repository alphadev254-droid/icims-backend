import { Router } from 'express';
import { authenticate, authorizePermission } from '../middleware/auth';
import * as givingController from '../controllers/givingController';
import * as pledgeController from '../controllers/pledgeController';

const router = Router();

// Public routes (no auth)
router.get('/campaigns/:id/public', givingController.getPublicCampaign);
router.get('/campaigns/:id/cells', givingController.getPublicCampaignCells);
router.post('/guest-donate', givingController.createGuestDonation);

// Campaigns
router.post('/campaigns', authenticate, authorizePermission('campaigns:create'), givingController.createCampaign);
router.get('/campaigns', authenticate, authorizePermission('campaigns:read'), givingController.getCampaigns);
router.get('/campaigns/:id', authenticate, authorizePermission('campaigns:read'), givingController.getCampaign);
router.put('/campaigns/:id', authenticate, authorizePermission('campaigns:update'), givingController.updateCampaign);
router.delete('/campaigns/:id', authenticate, authorizePermission('campaigns:delete'), givingController.deleteCampaign);

// Donations
router.post('/donate', authenticate, authorizePermission('donations:create'), givingController.createDonation);
router.post('/donations/cash', authenticate, authorizePermission('donations:create'), givingController.recordCashDonation);
router.get('/donations', authenticate, authorizePermission('donations:read'), givingController.getDonations);
router.get('/donations/:id/transaction', authenticate, authorizePermission('donations:read'), givingController.getDonationTransaction);

// Pledges — members can create/view their own; admins view all
router.post('/pledges', authenticate, pledgeController.createPledge);
router.get('/pledges/my', authenticate, pledgeController.getMyPledges);
router.get('/pledges', authenticate, authorizePermission('donations:read'), pledgeController.getMinistryPledges);
router.put('/pledges/:id', authenticate, pledgeController.updatePledge);
router.get('/pledges/:id', authenticate, pledgeController.getPledge);

export default router;
