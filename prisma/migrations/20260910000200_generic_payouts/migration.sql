ALTER TABLE `subaccounts`
  ADD COLUMN `providerSubaccountId` VARCHAR(191) NULL,
  ADD COLUMN `providerPayload` JSON NULL;

CREATE TABLE `payouts` (
  `id` VARCHAR(191) NOT NULL, `walletId` VARCHAR(191) NULL, `churchId` VARCHAR(191) NULL,
  `ministryAdminId` VARCHAR(191) NULL, `initiatedBy` VARCHAR(191) NULL,
  `scope` VARCHAR(191) NOT NULL DEFAULT 'ministry', `type` VARCHAR(191) NOT NULL,
  `gateway` VARCHAR(191) NOT NULL, `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
  `method` VARCHAR(191) NULL, `externalPayoutId` VARCHAR(191) NULL,
  `externalReference` VARCHAR(191) NULL, `providerAccountId` VARCHAR(191) NULL,
  `currency` VARCHAR(191) NOT NULL, `grossAmount` DECIMAL(18,2) NOT NULL DEFAULT 0,
  `feeAmount` DECIMAL(18,2) NOT NULL DEFAULT 0, `deductionAmount` DECIMAL(18,2) NOT NULL DEFAULT 0,
  `netAmount` DECIMAL(18,2) NOT NULL DEFAULT 0, `destinationType` VARCHAR(191) NULL,
  `destinationBank` VARCHAR(191) NULL, `destinationAccount` VARCHAR(191) NULL,
  `destinationAccountName` VARCHAR(191) NULL,
  `reconciliationStatus` VARCHAR(191) NOT NULL DEFAULT 'pending',
  `reconciliationDifference` DECIMAL(18,2) NULL, `failureReason` TEXT NULL,
  `providerPayload` JSON NULL, `providerResponse` JSON NULL,
  `settlementDate` DATETIME(3) NULL, `initiatedAt` DATETIME(3) NULL,
  `processedAt` DATETIME(3) NULL, `ledgerPostedAt` DATETIME(3) NULL,
  `legacyWithdrawalId` VARCHAR(191) NULL, `legacyPlatformWithdrawalId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `payouts_legacyWithdrawalId_key` (`legacyWithdrawalId`),
  UNIQUE INDEX `payouts_legacyPlatformWithdrawalId_key` (`legacyPlatformWithdrawalId`),
  UNIQUE INDEX `payouts_gateway_providerAccountId_externalPayoutId_key` (`gateway`, `providerAccountId`, `externalPayoutId`),
  INDEX `payouts_churchId_status_idx` (`churchId`, `status`),
  INDEX `payouts_walletId_createdAt_idx` (`walletId`, `createdAt`),
  INDEX `payouts_gateway_status_idx` (`gateway`, `status`),
  CONSTRAINT `payouts_walletId_fkey` FOREIGN KEY (`walletId`) REFERENCES `wallets` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `payouts_churchId_fkey` FOREIGN KEY (`churchId`) REFERENCES `churches` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `payout_allocations` (
  `id` VARCHAR(191) NOT NULL, `payoutId` VARCHAR(191) NOT NULL, `transactionId` VARCHAR(191) NOT NULL,
  `providerTransactionId` VARCHAR(191) NULL,
  `providerGrossAmount` DECIMAL(18,2) NOT NULL DEFAULT 0,
  `expectedAmount` DECIMAL(18,2) NOT NULL DEFAULT 0,
  `settledAmount` DECIMAL(18,2) NULL, `reconciliationStatus` VARCHAR(191) NOT NULL DEFAULT 'pending',
  `providerPayload` JSON NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `payout_allocations_payoutId_transactionId_key` (`payoutId`, `transactionId`),
  INDEX `payout_allocations_transactionId_idx` (`transactionId`),
  INDEX `payout_allocations_providerTransactionId_idx` (`providerTransactionId`),
  CONSTRAINT `payout_allocations_payoutId_fkey` FOREIGN KEY (`payoutId`) REFERENCES `payouts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `payout_allocations_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `transactions` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `gateway_events` (
  `id` VARCHAR(191) NOT NULL, `payoutId` VARCHAR(191) NULL, `gateway` VARCHAR(191) NOT NULL,
  `resourceType` VARCHAR(191) NOT NULL, `eventType` VARCHAR(191) NOT NULL,
  `externalId` VARCHAR(191) NULL, `externalReference` VARCHAR(191) NULL,
  `eventKey` VARCHAR(191) NOT NULL, `payloadHash` VARCHAR(191) NOT NULL, `payload` JSON NOT NULL,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `processedAt` DATETIME(3) NULL,
  `processingError` TEXT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `gateway_events_eventKey_key` (`eventKey`),
  INDEX `gateway_events_gateway_externalId_idx` (`gateway`, `externalId`),
  INDEX `gateway_events_externalReference_idx` (`externalReference`),
  INDEX `gateway_events_payoutId_receivedAt_idx` (`payoutId`, `receivedAt`),
  CONSTRAINT `gateway_events_payoutId_fkey` FOREIGN KEY (`payoutId`) REFERENCES `payouts` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
