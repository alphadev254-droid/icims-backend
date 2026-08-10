ALTER TABLE `users`
  ADD COLUMN `acceptedTerms` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `termsAcceptedAt` DATETIME(3) NULL,
  ADD COLUMN `termsVersion` VARCHAR(191) NULL,
  ADD COLUMN `privacyVersion` VARCHAR(191) NULL,
  ADD COLUMN `termsAcceptedIp` VARCHAR(191) NULL,
  ADD COLUMN `termsAcceptedUserAgent` TEXT NULL;
