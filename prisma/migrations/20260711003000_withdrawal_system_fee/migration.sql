ALTER TABLE `withdrawals`
  ADD COLUMN `gatewayFeeAmount` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN `gatewayFeeRate` DOUBLE NULL,
  ADD COLUMN `bankFixedFeeAmount` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN `systemFeeAmount` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN `systemFeeRate` DOUBLE NULL,
  ADD COLUMN `payoutAmount` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN `gatewayPayload` LONGTEXT NULL,
  MODIFY COLUMN `gatewayResponse` LONGTEXT NULL;

UPDATE `withdrawals`
SET `gatewayFeeAmount` = `fee`
WHERE `gatewayFeeAmount` = 0 AND `fee` IS NOT NULL;

UPDATE `withdrawals`
SET `payoutAmount` = `netAmount`
WHERE `payoutAmount` = 0 AND `netAmount` IS NOT NULL;
