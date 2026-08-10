import { Router } from 'express';
import { authenticate, authorizeAnyPermission, authorizePermission } from '../middleware/auth';
import * as givingController from '../controllers/givingController';
import * as pledgeController from '../controllers/pledgeController';

const router = Router();

// Public routes (no auth)
router.get('/campaigns/:id/public', givingController.getPublicCampaign);
router.get('/campaigns/:id/cells', givingController.getPublicCampaignCells);
router.post('/guest-donate', givingController.createGuestDonation);
router.post('/guest-donate-multiple', givingController.createGuestMultipleDonation);

// Campaigns
router.post('/campaigns', authenticate, authorizePermission('campaigns:create'), givingController.createCampaign);
router.get('/campaigns/select', authenticate, authorizeAnyPermission([
  'campaigns:read',
  'campaigns:create',
  'campaigns:update',
  'cells:read',
  'cells:update',
  'donations:read',
  'donations:create',
  'transactions:read',
  'reports:read',
]), givingController.getCampaignSelect);
router.get('/campaigns', authenticate, authorizePermission('campaigns:read'), givingController.getCampaigns);
router.get('/summary', authenticate, authorizePermission('donations:read'), givingController.getGivingSummary);
router.get('/campaigns/:id', authenticate, authorizePermission('campaigns:read'), givingController.getCampaign);
router.put('/campaigns/:id', authenticate, authorizePermission('campaigns:update'), givingController.updateCampaign);
router.delete('/campaigns/:id', authenticate, authorizePermission('campaigns:delete'), givingController.deleteCampaign);

// Donations
router.post('/donate', authenticate, authorizePermission('donations:create'), givingController.createDonation);
router.post('/donate-multiple', authenticate, authorizePermission('donations:create'), givingController.createMultipleDonation);
router.post('/donations/cash', authenticate, authorizePermission('donations:create'), givingController.recordCashDonation);
router.get('/donations', authenticate, authorizePermission('donations:read'), givingController.getDonations);
router.get('/donations/:id/transaction', authenticate, authorizePermission('donations:read'), givingController.getDonationTransaction);

// Pledges — members can create/view their own; admins view all
router.post('/pledges', authenticate, pledgeController.createPledge);
router.get('/pledges/my', authenticate, pledgeController.getMyPledges);
router.get('/pledges', authenticate, authorizePermission('donations:read'), pledgeController.getMinistryPledges);
router.post('/pledges/:id/payments', authenticate, authorizePermission('donations:create'), pledgeController.recordPledgePayment);
router.put('/pledges/:id', authenticate, pledgeController.updatePledge);
router.get('/pledges/:id', authenticate, pledgeController.getPledge);

export default router;
