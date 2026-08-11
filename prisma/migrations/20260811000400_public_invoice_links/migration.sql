ALTER TABLE `package_invoices`
  ADD COLUMN `publicToken` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `package_invoices_publicToken_key` ON `package_invoices`(`publicToken`);
CREATE INDEX `package_invoices_publicToken_idx` ON `package_invoices`(`publicToken`);
