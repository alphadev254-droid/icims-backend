DROP INDEX `donation_transactions_transactionId_key` ON `donation_transactions`;
DROP INDEX `donation_transactions_reference_key` ON `donation_transactions`;

CREATE INDEX `donation_transactions_transactionId_idx` ON `donation_transactions`(`transactionId`);
CREATE INDEX `donation_transactions_reference_idx` ON `donation_transactions`(`reference`);
