CREATE TABLE `ledger_entries` (
  `id` VARCHAR(191) NOT NULL,
  `walletId` VARCHAR(191) NOT NULL,
  `direction` VARCHAR(32) NOT NULL,
  `category` VARCHAR(64) NOT NULL,
  `amount` DECIMAL(18,2) NOT NULL,
  `currency` VARCHAR(16) NOT NULL,
  `sourceType` VARCHAR(64) NOT NULL,
  `sourceId` VARCHAR(191) NULL,
  `description` TEXT NULL,
  `legacyWalletTransactionId` VARCHAR(191) NULL,
  `effectiveAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `ledger_entries_legacyWalletTransactionId_key` (`legacyWalletTransactionId`),
  INDEX `ledger_entries_walletId_effectiveAt_idx` (`walletId`, `effectiveAt`),
  INDEX `ledger_entries_sourceType_sourceId_idx` (`sourceType`, `sourceId`),
  CONSTRAINT `ledger_entries_walletId_fkey` FOREIGN KEY (`walletId`) REFERENCES `wallets` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `payout_reservations` (
  `id` VARCHAR(191) NOT NULL,
  `payoutId` VARCHAR(191) NOT NULL,
  `walletId` VARCHAR(191) NOT NULL,
  `amount` DECIMAL(18,2) NOT NULL,
  `currency` VARCHAR(16) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `releasedAt` DATETIME(3) NULL,
  `convertedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `payout_reservations_payoutId_walletId_key` (`payoutId`, `walletId`),
  INDEX `payout_reservations_walletId_status_idx` (`walletId`, `status`),
  CONSTRAINT `payout_reservations_payoutId_fkey` FOREIGN KEY (`payoutId`) REFERENCES `payouts` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `payout_reservations_walletId_fkey` FOREIGN KEY (`walletId`) REFERENCES `wallets` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `wallet_balance_snapshots` (
  `id` VARCHAR(191) NOT NULL,
  `walletId` VARCHAR(191) NOT NULL,
  `postedBalance` DECIMAL(18,2) NOT NULL DEFAULT 0,
  `reservedBalance` DECIMAL(18,2) NOT NULL DEFAULT 0,
  `availableBalance` DECIMAL(18,2) NOT NULL DEFAULT 0,
  `version` INTEGER NOT NULL DEFAULT 0,
  `rebuiltAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `wallet_balance_snapshots_walletId_key` (`walletId`),
  CONSTRAINT `wallet_balance_snapshots_walletId_fkey` FOREIGN KEY (`walletId`) REFERENCES `wallets` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `ledger_entries` (`id`, `walletId`, `direction`, `category`, `amount`, `currency`, `sourceType`, `sourceId`, `description`, `legacyWalletTransactionId`, `effectiveAt`, `createdAt`)
SELECT CONCAT('legacy-', wt.`id`), wt.`walletId`, wt.`type`, wt.`source`, ROUND(wt.`amount`, 2), w.`currency`, 'wallet_transaction', wt.`sourceId`, wt.`description`, wt.`id`, wt.`createdAt`, wt.`createdAt`
FROM `wallet_transactions` wt
JOIN `wallets` w ON w.`id` = wt.`walletId`
ON DUPLICATE KEY UPDATE `legacyWalletTransactionId` = VALUES(`legacyWalletTransactionId`);

INSERT INTO `wallet_balance_snapshots` (`id`, `walletId`, `postedBalance`, `reservedBalance`, `availableBalance`, `version`, `rebuiltAt`, `updatedAt`)
SELECT CONCAT('snapshot-', w.`id`), w.`id`,
  COALESCE(SUM(CASE WHEN le.`direction` = 'credit' THEN le.`amount` ELSE -le.`amount` END), 0),
  0,
  COALESCE(SUM(CASE WHEN le.`direction` = 'credit' THEN le.`amount` ELSE -le.`amount` END), 0),
  1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `wallets` w
LEFT JOIN `ledger_entries` le ON le.`walletId` = w.`id`
GROUP BY w.`id`
ON DUPLICATE KEY UPDATE
  `postedBalance` = VALUES(`postedBalance`),
  `reservedBalance` = VALUES(`reservedBalance`),
  `availableBalance` = VALUES(`availableBalance`),
  `version` = `version` + 1,
  `rebuiltAt` = CURRENT_TIMESTAMP(3),
  `updatedAt` = CURRENT_TIMESTAMP(3);

CREATE TRIGGER `wallet_transactions_mirror_to_ledger`
AFTER INSERT ON `wallet_transactions`
FOR EACH ROW
INSERT IGNORE INTO `ledger_entries` (`id`, `walletId`, `direction`, `category`, `amount`, `currency`, `sourceType`, `sourceId`, `description`, `legacyWalletTransactionId`, `effectiveAt`, `createdAt`)
SELECT UUID(), NEW.`walletId`, NEW.`type`, NEW.`source`, ROUND(NEW.`amount`, 2), w.`currency`, 'wallet_transaction', NEW.`sourceId`, NEW.`description`, NEW.`id`, NEW.`createdAt`, NEW.`createdAt`
FROM `wallets` w WHERE w.`id` = NEW.`walletId`;

CREATE TRIGGER `ledger_entries_update_balance_snapshot`
AFTER INSERT ON `ledger_entries`
FOR EACH ROW
INSERT INTO `wallet_balance_snapshots` (`id`, `walletId`, `postedBalance`, `reservedBalance`, `availableBalance`, `version`, `rebuiltAt`, `updatedAt`)
VALUES (UUID(), NEW.`walletId`, IF(NEW.`direction` = 'credit', NEW.`amount`, -NEW.`amount`), 0, IF(NEW.`direction` = 'credit', NEW.`amount`, -NEW.`amount`), 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE
  `postedBalance` = `postedBalance` + IF(NEW.`direction` = 'credit', NEW.`amount`, -NEW.`amount`),
  `availableBalance` = `postedBalance` - `reservedBalance`,
  `version` = `version` + 1,
  `updatedAt` = CURRENT_TIMESTAMP(3);
