ALTER TABLE `giving_campaigns`
  ADD COLUMN `scopeType` VARCHAR(191) NOT NULL DEFAULT 'one_church';

CREATE TABLE `giving_campaign_churches` (
  `id` VARCHAR(191) NOT NULL,
  `campaignId` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `giving_campaign_churches_campaignId_churchId_key`(`campaignId`, `churchId`),
  INDEX `giving_campaign_churches_churchId_idx`(`churchId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `giving_campaign_churches`
  ADD CONSTRAINT `giving_campaign_churches_campaignId_fkey`
  FOREIGN KEY (`campaignId`) REFERENCES `giving_campaigns`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `giving_campaign_churches`
  ADD CONSTRAINT `giving_campaign_churches_churchId_fkey`
  FOREIGN KEY (`churchId`) REFERENCES `churches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO `giving_campaign_churches` (`id`, `campaignId`, `churchId`, `createdAt`)
SELECT CONCAT('gcl_', REPLACE(UUID(), '-', '')), `id`, `churchId`, NOW(3)
FROM `giving_campaigns`;

CREATE INDEX `giving_campaigns_scopeType_idx` ON `giving_campaigns`(`scopeType`);
