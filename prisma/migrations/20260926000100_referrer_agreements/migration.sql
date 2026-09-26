ALTER TABLE `referrers`
  ADD COLUMN `agreementTemplateUrl` VARCHAR(191) NULL DEFAULT '/uploads/marketer-agreements/Midas_Marketer_Referral_Agreement.pdf',
  ADD COLUMN `signedAgreementUrl` VARCHAR(191) NULL,
  ADD COLUMN `signedAgreementFileName` VARCHAR(191) NULL,
  ADD COLUMN `agreementStatus` VARCHAR(191) NOT NULL DEFAULT 'not_submitted',
  ADD COLUMN `agreementSubmittedAt` DATETIME(3) NULL,
  ADD COLUMN `agreementReviewedAt` DATETIME(3) NULL,
  ADD COLUMN `agreementReviewedById` VARCHAR(191) NULL,
  ADD COLUMN `agreementRejectionReason` TEXT NULL;

CREATE INDEX `referrers_agreementStatus_idx` ON `referrers`(`agreementStatus`);
