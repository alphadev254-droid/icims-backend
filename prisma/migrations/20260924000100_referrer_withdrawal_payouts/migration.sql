ALTER TABLE `referrer_withdrawals`
  ADD COLUMN `mobileOperator` VARCHAR(191) NULL,
  ADD COLUMN `chargeId` VARCHAR(191) NULL,
  ADD COLUMN `feeAmount` DECIMAL(18,2) NULL,
  ADD COLUMN `gatewayFeeRate` DECIMAL(10,6) NULL,
  ADD COLUMN `payoutAmount` DECIMAL(18,2) NULL,
  ADD COLUMN `gatewayPayload` LONGTEXT NULL,
  ADD COLUMN `gatewayResponse` LONGTEXT NULL,
  ADD COLUMN `failureReason` TEXT NULL,
  ADD COLUMN `processedAt` DATETIME(3) NULL,
  ADD COLUMN `attempts` INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX `referrer_withdrawals_chargeId_key` ON `referrer_withdrawals`(`chargeId`);
