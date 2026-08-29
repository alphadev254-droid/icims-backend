import { Router } from 'express';
import { authenticate, authorizeAnyPermission, authorizePermission } from '../middleware/auth';
import { requireFeature } from '../middleware/packageCheck';
import * as givingController from '../controllers/givingController';
import * as pledgeController from '../controllers/pledgeController';

const router = Router();

// Public routes (no auth)
router.get('/campaigns/:id/public', givingController.getPublicCampaign);
router.get('/campaigns/:id/cells', givingController.getPublicCampaignCells);
router.post('/guest-donate', givingController.createGuestDonation);
router.post('/guest-donate-multiple', givingController.createGuestMultipleDonation);

// Campaigns
router.post('/campaigns', authenticate, requireFeature('giving_campaigns'), authorizePermission('campaigns:create'), givingController.createCampaign);
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
]), requireFeature('giving_tracking'), givingController.getCampaignSelect);
router.get('/campaigns', authenticate, requireFeature('giving_tracking'), authorizePermission('campaigns:read'), givingController.getCampaigns);
router.get('/summary', authenticate, requireFeature('transactions_view'), authorizePermission('donations:read'), givingController.getGivingSummary);
router.get('/campaigns/:id', authenticate, requireFeature('giving_tracking'), authorizePermission('campaigns:read'), givingController.getCampaign);
router.put('/campaigns/:id', authenticate, requireFeature('giving_campaigns'), authorizePermission('campaigns:update'), givingController.updateCampaign);
router.delete('/campaigns/:id', authenticate, requireFeature('giving_campaigns'), authorizePermission('campaigns:delete'), givingController.deleteCampaign);

// Donations
router.post('/donate', authenticate, requireFeature('giving_online_payments'), authorizePermission('donations:create'), givingController.createDonation);
router.post('/donate-multiple', authenticate, requireFeature('giving_online_payments'), authorizePermission('donations:create'), givingController.createMultipleDonation);
router.post('/donations/cash', authenticate, requireFeature('giving_manual_records'), authorizePermission('donations:create'), givingController.recordCashDonation);
router.get('/donations', authenticate, requireFeature('transactions_view'), authorizePermission('donations:read'), givingController.getDonations);
router.get('/donations/:id/transaction', authenticate, requireFeature('transactions_view'), authorizePermission('donations:read'), givingController.getDonationTransaction);

// Pledges — members can create/view their own; admins view all
router.post('/pledges', authenticate, requireFeature('pledges_management'), pledgeController.createPledge);
router.get('/pledges/my', authenticate, requireFeature('pledges_management'), pledgeController.getMyPledges);
router.get('/pledges', authenticate, requireFeature('pledges_management'), authorizePermission('donations:read'), pledgeController.getMinistryPledges);
router.post('/pledges/:id/payments', authenticate, requireFeature('giving_manual_records'), authorizePermission('donations:create'), pledgeController.recordPledgePayment);
router.put('/pledges/:id', authenticate, requireFeature('pledges_management'), pledgeController.updatePledge);
router.get('/pledges/:id', authenticate, requireFeature('pledges_management'), pledgeController.getPledge);

export default router;
