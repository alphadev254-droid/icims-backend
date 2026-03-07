import { Router } from 'express';
import { paychanguWebhook } from '../controllers/paychanguWebhookController';
import { paychanguCallback } from '../controllers/paychanguCallbackController';

const router = Router();

// Paychangu callback (user redirect - GET)
router.get('/paychangu/callback', paychanguCallback);

// Paychangu webhook (server notification - POST)
router.post('/paychangu', paychanguWebhook);

export default router;
