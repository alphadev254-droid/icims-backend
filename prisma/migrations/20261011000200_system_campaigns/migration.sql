-- A failed first attempt may have created the parent tables before MySQL
-- rejected a later identifier. Make Prisma's rolled-back retry safe.
DROP TABLE IF EXISTS `system_campaign_delivery_attempts`;
DROP TABLE IF EXISTS `system_campaign_recipients`;
DROP TABLE IF EXISTS `system_campaigns`;

CREATE TABLE `system_campaigns` (
  `id` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `summary` TEXT NULL,
  `message` TEXT NOT NULL,
  `category` VARCHAR(191) NOT NULL DEFAULT 'general',
  `priority` VARCHAR(191) NOT NULL DEFAULT 'normal',
  `visibilityPolicy` VARCHAR(191) NOT NULL DEFAULT 'standard',
  `audienceType` VARCHAR(191) NOT NULL DEFAULT 'all_ministries',
  `audienceFilters` TEXT NULL,
  `channels` TEXT NOT NULL,
  `actionLabel` VARCHAR(191) NULL,
  `actionUrl` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
  `scheduledAt` DATETIME(3) NULL,
  `sendingStartedAt` DATETIME(3) NULL,
  `sentAt` DATETIME(3) NULL,
  `cancelledAt` DATETIME(3) NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `system_campaigns_status_createdAt_idx` (`status`, `createdAt`),
  INDEX `system_campaigns_scheduledAt_status_idx` (`scheduledAt`, `status`),
  CONSTRAINT `system_campaigns_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `system_campaign_recipients` (
  `id` VARCHAR(191) NOT NULL,
  `campaignId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `recipientName` VARCHAR(191) NOT NULL,
  `recipientEmail` VARCHAR(191) NOT NULL,
  `ministryName` VARCHAR(191) NULL,
  `country` VARCHAR(191) NULL,
  `inAppStatus` VARCHAR(191) NOT NULL DEFAULT 'pending',
  `emailStatus` VARCHAR(191) NOT NULL DEFAULT 'not_requested',
  `pushStatus` VARCHAR(191) NOT NULL DEFAULT 'not_requested',
  `readAt` DATETIME(3) NULL,
  `acknowledgedAt` DATETIME(3) NULL,
  `dismissedAt` DATETIME(3) NULL,
  `lastError` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `system_campaign_recipients_campaignId_userId_key` (`campaignId`, `userId`),
  INDEX `system_campaign_recipients_userId_readAt_createdAt_idx` (`userId`, `readAt`, `createdAt`),
  INDEX `system_campaign_recipients_campaignId_emailStatus_idx` (`campaignId`, `emailStatus`),
  CONSTRAINT `system_campaign_recipients_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `system_campaigns` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `system_campaign_recipients_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `system_campaign_delivery_attempts` (
  `id` VARCHAR(191) NOT NULL,
  `campaignRecipientId` VARCHAR(191) NOT NULL,
  `channel` VARCHAR(191) NOT NULL,
  `attemptNumber` INTEGER NOT NULL DEFAULT 1,
  `status` VARCHAR(191) NOT NULL,
  `providerMessageId` VARCHAR(191) NULL,
  `errorCode` VARCHAR(191) NULL,
  `errorMessage` TEXT NULL,
  `attemptedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `sys_campaign_attempt_recipient_channel_idx` (`campaignRecipientId`, `channel`),
  CONSTRAINT `system_campaign_delivery_attempts_campaignRecipientId_fkey` FOREIGN KEY (`campaignRecipientId`) REFERENCES `system_campaign_recipients` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `permissions` (`id`, `name`, `resource`, `action`)
VALUES
  (CONCAT('sysnotifread-', UUID()), 'system_notifications:read', 'system_notifications', 'read'),
  (CONCAT('sysnotifack-', UUID()), 'system_notifications:acknowledge', 'system_notifications', 'acknowledge');

INSERT IGNORE INTO `role_permissions` (`ministryAdminId`, `roleId`, `permissionId`)
SELECT 'GLOBAL', r.`id`, p.`id`
FROM `roles` r
JOIN `permissions` p ON p.`name` IN ('system_notifications:read', 'system_notifications:acknowledge')
WHERE r.`name` = 'ministry_admin';
