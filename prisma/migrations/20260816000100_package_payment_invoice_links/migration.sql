CREATE TABLE `package_payment_invoices` (
  `id` VARCHAR(191) NOT NULL,
  `paymentId` VARCHAR(191) NOT NULL,
  `invoiceId` VARCHAR(191) NOT NULL,
  `amount` DOUBLE NOT NULL,
  `currency` VARCHAR(191) NOT NULL DEFAULT 'MWK',
  `role` VARCHAR(191) NOT NULL DEFAULT 'primary',
  `months` INTEGER NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `package_payment_invoices_paymentId_invoiceId_key`(`paymentId`, `invoiceId`),
  INDEX `package_payment_invoices_invoiceId_idx`(`invoiceId`),
  INDEX `package_payment_invoices_paymentId_idx`(`paymentId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `package_payment_invoices`
  ADD CONSTRAINT `package_payment_invoices_paymentId_fkey`
  FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `package_payment_invoices`
  ADD CONSTRAINT `package_payment_invoices_invoiceId_fkey`
  FOREIGN KEY (`invoiceId`) REFERENCES `package_invoices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

