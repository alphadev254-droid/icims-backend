CREATE TABLE `package_market_feature_overrides` (
    `id` VARCHAR(191) NOT NULL,
    `packageId` VARCHAR(191) NOT NULL,
    `pricingMarketId` VARCHAR(191) NOT NULL,
    `featureId` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL,
    `limitValue` INTEGER NULL,
    `reason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `pkg_market_feat_override_key`(`packageId`, `pricingMarketId`, `featureId`),
    INDEX `package_market_feature_overrides_pricingMarketId_idx`(`pricingMarketId`),
    INDEX `package_market_feature_overrides_featureId_idx`(`featureId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `package_market_feature_overrides`
    ADD CONSTRAINT `package_market_feature_overrides_packageId_fkey`
    FOREIGN KEY (`packageId`) REFERENCES `packages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `package_market_feature_overrides`
    ADD CONSTRAINT `package_market_feature_overrides_pricingMarketId_fkey`
    FOREIGN KEY (`pricingMarketId`) REFERENCES `pricing_markets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `package_market_feature_overrides`
    ADD CONSTRAINT `package_market_feature_overrides_featureId_fkey`
    FOREIGN KEY (`featureId`) REFERENCES `package_features`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
