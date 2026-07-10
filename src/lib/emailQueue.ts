/**
 * Email Queue - BullMQ with Redis
 * Re-exports from bullQueue.ts for backward compatibility
 */

export {
  queueEmailBull as queueEmail,
  emailQueue,
  emailWorker,
  getEmailQueueStats,
  retryFailedEmail,
  cleanEmailQueue,
} from './bullQueue';

export type { EmailJobData, EmailAttachment } from './bullQueue';

// Keep EmailType export for backward compatibility
export type EmailType =
  | 'user_created'
  | 'registration'
  | 'password_reset'
  | 'password_changed'
  | 'ticket_purchase'
  | 'donation_receipt'
  | 'withdrawal_request_user'
  | 'withdrawal_request_admin'
  | 'withdrawal_otp'
  | 'withdrawal_final_status'
  | 'package_subscription'
  | 'notification';
