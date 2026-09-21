ALTER TABLE `payments`
  ADD COLUMN `referralId` VARCHAR(191) NULL,
  ADD COLUMN `referrerId` VARCHAR(191) NULL,
  ADD COLUMN `referralCommissionRate` DECIMAL(10,6) NULL,
  ADD COLUMN `referralCommissionAmount` DECIMAL(18,2) NULL,
  ADD COLUMN `referralCommissionStatus` VARCHAR(191) NULL;

ALTER TABLE `users`
  ADD COLUMN `emailVerified` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `emailVerifiedAt` DATETIME(3) NULL;

CREATE TABLE `email_verification_otps` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `otpHash` VARCHAR(191) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `usedAt` DATETIME(3) NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `email_verification_otps_userId_expiresAt_idx` (`userId`, `expiresAt`),
  CONSTRAINT `email_verification_otps_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `referrers` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `code` VARCHAR(191) NOT NULL,
  `type` VARCHAR(191) NOT NULL DEFAULT 'referrer',
  `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
  `displayName` VARCHAR(191) NULL,
  `phone` VARCHAR(191) NULL,
  `country` VARCHAR(191) NULL,
  `city` VARCHAR(191) NULL,
  `district` VARCHAR(191) NULL,
  `pricingMarketId` VARCHAR(191) NULL,
  `payoutPhone` VARCHAR(191) NULL,
  `payoutProvider` VARCHAR(191) NULL,
  `payoutSetupStatus` VARCHAR(191) NOT NULL DEFAULT 'pending',
  `approvedAt` DATETIME(3) NULL,
  `approvedById` VARCHAR(191) NULL,
  `rejectionReason` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `referrers_userId_key` (`userId`),
  UNIQUE INDEX `referrers_code_key` (`code`),
  INDEX `referrers_status_idx` (`status`),
  INDEX `referrers_type_idx` (`type`),
  INDEX `referrers_pricingMarketId_idx` (`pricingMarketId`),
  CONSTRAINT `referrers_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `referrers_pricingMarketId_fkey` FOREIGN KEY (`pricingMarketId`) REFERENCES `pricing_markets` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `referral_links` (
  `id` VARCHAR(191) NOT NULL,
  `referrerId` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NULL,
  `referralCode` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'registered',
  `registeredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `firstPaymentAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `referral_links_ministryAdminId_key` (`ministryAdminId`),
  INDEX `referral_links_referrerId_idx` (`referrerId`),
  INDEX `referral_links_churchId_idx` (`churchId`),
  INDEX `referral_links_referralCode_idx` (`referralCode`),
  CONSTRAINT `referral_links_referrerId_fkey` FOREIGN KEY (`referrerId`) REFERENCES `referrers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `referral_links_ministryAdminId_fkey` FOREIGN KEY (`ministryAdminId`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `referral_links_churchId_fkey` FOREIGN KEY (`churchId`) REFERENCES `churches` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `referrer_ledger_entries` (
  `id` VARCHAR(191) NOT NULL,
  `referrerId` VARCHAR(191) NOT NULL,
  `direction` VARCHAR(191) NOT NULL,
  `category` VARCHAR(191) NOT NULL,
  `amount` DECIMAL(18,2) NOT NULL,
  `currency` VARCHAR(191) NOT NULL DEFAULT 'MWK',
  `balanceAfter` DECIMAL(18,2) NULL,
  `sourceType` VARCHAR(191) NOT NULL,
  `sourceId` VARCHAR(191) NULL,
  `paymentId` VARCHAR(191) NULL,
  `withdrawalId` VARCHAR(191) NULL,
  `description` TEXT NULL,
  `effectiveAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `referrer_ledger_entries_sourceType_sourceId_category_key` (`sourceType`, `sourceId`, `category`),
  INDEX `referrer_ledger_entries_referrerId_effectiveAt_idx` (`referrerId`, `effectiveAt`),
  INDEX `referrer_ledger_entries_paymentId_idx` (`paymentId`),
  INDEX `referrer_ledger_entries_withdrawalId_idx` (`withdrawalId`),
  CONSTRAINT `referrer_ledger_entries_referrerId_fkey` FOREIGN KEY (`referrerId`) REFERENCES `referrers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `referrer_withdrawals` (
  `id` VARCHAR(191) NOT NULL,
  `referrerId` VARCHAR(191) NOT NULL,
  `amount` DECIMAL(18,2) NOT NULL,
  `currency` VARCHAR(191) NOT NULL DEFAULT 'MWK',
  `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
  `method` VARCHAR(191) NULL,
  `accountName` VARCHAR(191) NULL,
  `accountNumber` VARCHAR(191) NULL,
  `mobileNumber` VARCHAR(191) NULL,
  `bankName` VARCHAR(191) NULL,
  `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `approvedAt` DATETIME(3) NULL,
  `paidAt` DATETIME(3) NULL,
  `processedById` VARCHAR(191) NULL,
  `rejectionReason` TEXT NULL,
  `notes` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `referrer_withdrawals_referrerId_status_idx` (`referrerId`, `status`),
  INDEX `referrer_withdrawals_createdAt_idx` (`createdAt`),
  CONSTRAINT `referrer_withdrawals_referrerId_fkey` FOREIGN KEY (`referrerId`) REFERENCES `referrers` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `referrer_withdrawal_otps` (
  `id` VARCHAR(191) NOT NULL,
  `referrerId` VARCHAR(191) NOT NULL,
  `withdrawalId` VARCHAR(191) NULL,
  `otpHash` VARCHAR(191) NOT NULL,
  `payloadHash` VARCHAR(191) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `usedAt` DATETIME(3) NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `referrer_withdrawal_otps_referrerId_expiresAt_idx` (`referrerId`, `expiresAt`),
  INDEX `referrer_withdrawal_otps_payloadHash_idx` (`payloadHash`),
  CONSTRAINT `referrer_withdrawal_otps_referrerId_fkey` FOREIGN KEY (`referrerId`) REFERENCES `referrers` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `referrer_withdrawal_otps_withdrawalId_fkey` FOREIGN KEY (`withdrawalId`) REFERENCES `referrer_withdrawals` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `payments`
  ADD INDEX `payments_referralId_idx` (`referralId`),
  ADD INDEX `payments_referrerId_idx` (`referrerId`),
  ADD CONSTRAINT `payments_referralId_fkey` FOREIGN KEY (`referralId`) REFERENCES `referral_links` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `payments_referrerId_fkey` FOREIGN KEY (`referrerId`) REFERENCES `referrers` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO `roles` (`id`, `name`, `displayName`, `description`, `isSystemRole`, `createdAt`, `updatedAt`)
SELECT CONCAT('role-', UUID()), 'referrer', 'Referrer', 'Referral partner account', true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (SELECT 1 FROM `roles` WHERE `name` = 'referrer');
