CREATE TABLE `withdrawal_otps` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `otpHash` VARCHAR(191) NOT NULL,
  `payloadHash` VARCHAR(191) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `usedAt` DATETIME(3) NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `withdrawal_otps_userId_expiresAt_idx` ON `withdrawal_otps`(`userId`, `expiresAt`);
CREATE INDEX `withdrawal_otps_payloadHash_idx` ON `withdrawal_otps`(`payloadHash`);

ALTER TABLE `withdrawal_otps`
  ADD CONSTRAINT `withdrawal_otps_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
