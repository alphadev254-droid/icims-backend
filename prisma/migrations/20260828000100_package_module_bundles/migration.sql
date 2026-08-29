CREATE TABLE `module_bundles` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `category` VARCHAR(191) NOT NULL DEFAULT 'core',
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `module_bundles_key_key`(`key`),
    INDEX `module_bundles_category_sortOrder_idx`(`category`, `sortOrder`),
    INDEX `module_bundles_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `module_bundle_features` (
    `bundleId` VARCHAR(191) NOT NULL,
    `featureId` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `limitValue` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `module_bundle_features_featureId_idx`(`featureId`),
    PRIMARY KEY (`bundleId`, `featureId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `package_module_bundles` (
    `packageId` VARCHAR(191) NOT NULL,
    `bundleId` VARCHAR(191) NOT NULL,
    `limitValue` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `package_module_bundles_bundleId_idx`(`bundleId`),
    PRIMARY KEY (`packageId`, `bundleId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `package_bundle_feature_overrides` (
    `id` VARCHAR(191) NOT NULL,
    `packageId` VARCHAR(191) NOT NULL,
    `bundleId` VARCHAR(191) NOT NULL,
    `featureId` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL,
    `limitValue` INTEGER NULL,
    `reason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `package_bundle_feature_overrides_packageId_bundleId_featureId_key`(`packageId`, `bundleId`, `featureId`),
    INDEX `package_bundle_feature_overrides_bundleId_idx`(`bundleId`),
    INDEX `package_bundle_feature_overrides_featureId_idx`(`featureId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `module_bundle_features` ADD CONSTRAINT `module_bundle_features_bundleId_fkey` FOREIGN KEY (`bundleId`) REFERENCES `module_bundles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `module_bundle_features` ADD CONSTRAINT `module_bundle_features_featureId_fkey` FOREIGN KEY (`featureId`) REFERENCES `package_features`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `package_module_bundles` ADD CONSTRAINT `package_module_bundles_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `packages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `package_module_bundles` ADD CONSTRAINT `package_module_bundles_bundleId_fkey` FOREIGN KEY (`bundleId`) REFERENCES `module_bundles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `package_bundle_feature_overrides` ADD CONSTRAINT `package_bundle_feature_overrides_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `packages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `package_bundle_feature_overrides` ADD CONSTRAINT `package_bundle_feature_overrides_bundleId_fkey` FOREIGN KEY (`bundleId`) REFERENCES `module_bundles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `package_bundle_feature_overrides` ADD CONSTRAINT `package_bundle_feature_overrides_featureId_fkey` FOREIGN KEY (`featureId`) REFERENCES `package_features`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
