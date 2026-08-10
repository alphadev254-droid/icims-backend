CREATE INDEX `pledges_userId_status_createdAt_idx` ON `pledges`(`userId`, `status`, `createdAt`);
CREATE INDEX `pledges_churchId_createdAt_idx` ON `pledges`(`churchId`, `createdAt`);
CREATE INDEX `pledges_churchId_status_createdAt_idx` ON `pledges`(`churchId`, `status`, `createdAt`);
CREATE INDEX `pledges_churchId_fulfillmentDeadline_idx` ON `pledges`(`churchId`, `fulfillmentDeadline`);
CREATE INDEX `pledges_campaignId_churchId_status_idx` ON `pledges`(`campaignId`, `churchId`, `status`);
CREATE INDEX `donation_transactions_pledgeId_status_createdAt_idx` ON `donation_transactions`(`pledgeId`, `status`, `createdAt`);
