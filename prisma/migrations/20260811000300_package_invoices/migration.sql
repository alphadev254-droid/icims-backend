ALTER TABLE `payments` ADD COLUMN `invoiceId` VARCHAR(191) NULL;

CREATE TABLE `package_invoices` (
  `id` VARCHAR(191) NOT NULL,
  `invoiceNumber` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `packageId` VARCHAR(191) NOT NULL,
  `packageName` VARCHAR(191) NOT NULL,
  `billingCycle` VARCHAR(191) NOT NULL DEFAULT 'monthly',
  `currency` VARCHAR(191) NOT NULL DEFAULT 'MWK',
  `amount` DOUBLE NOT NULL,
  `amountPaid` DOUBLE NOT NULL DEFAULT 0,
  `balanceDue` DOUBLE NOT NULL DEFAULT 0,
  `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
  `invoiceDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `dueDate` DATETIME(3) NOT NULL,
  `servicePeriodStart` DATETIME(3) NOT NULL,
  `servicePeriodEnd` DATETIME(3) NOT NULL,
  `lineItems` LONGTEXT NULL,
  `notes` TEXT NULL,
  `terms` TEXT NULL,
  `sentAt` DATETIME(3) NULL,
  `paidAt` DATETIME(3) NULL,
  `lastReminderAt` DATETIME(3) NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `package_invoices_invoiceNumber_key`(`invoiceNumber`),
  INDEX `package_invoices_ministryAdminId_status_idx`(`ministryAdminId`, `status`),
  INDEX `package_invoices_packageId_idx`(`packageId`),
  INDEX `package_invoices_dueDate_idx`(`dueDate`),
  INDEX `package_invoices_servicePeriodStart_servicePeriodEnd_idx`(`servicePeriodStart`, `servicePeriodEnd`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `package_invoices` ADD CONSTRAINT `package_invoices_ministryAdminId_fkey` FOREIGN KEY (`ministryAdminId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `package_invoices` ADD CONSTRAINT `package_invoices_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `packages`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `package_invoices` ADD CONSTRAINT `package_invoices_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `payments` ADD CONSTRAINT `payments_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `package_invoices`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX `payments_invoiceId_idx` ON `payments`(`invoiceId`);
