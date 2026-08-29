CREATE TABLE `pricing_markets` (
  `id` VARCHAR(191) NOT NULL,
  `code` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `currencyCode` VARCHAR(191) NOT NULL DEFAULT 'KES',
  `packageGateway` VARCHAR(191) NOT NULL DEFAULT 'paystack',
  `isDefault` BOOLEAN NOT NULL DEFAULT false,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `pricing_markets_code_key`(`code`),
  INDEX `pricing_markets_isActive_sortOrder_idx`(`isActive`, `sortOrder`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `packages`
  ADD COLUMN `currencyCode` VARCHAR(191) NOT NULL DEFAULT 'USD';

CREATE TABLE `countries` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `iso2` VARCHAR(191) NOT NULL,
  `iso3` VARCHAR(191) NULL,
  `phoneCode` VARCHAR(191) NULL,
  `currencyCode` VARCHAR(191) NULL,
  `pricingMarketId` VARCHAR(191) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `countries_name_key`(`name`),
  UNIQUE INDEX `countries_iso2_key`(`iso2`),
  INDEX `countries_pricingMarketId_idx`(`pricingMarketId`),
  INDEX `countries_isActive_name_idx`(`isActive`, `name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `package_market_prices` (
  `id` VARCHAR(191) NOT NULL,
  `packageId` VARCHAR(191) NOT NULL,
  `pricingMarketId` VARCHAR(191) NOT NULL,
  `priceMonthly` DOUBLE NOT NULL,
  `priceYearly` DOUBLE NOT NULL,
  `currencyCode` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `pkg_market_price_key`(`packageId`, `pricingMarketId`),
  INDEX `package_market_prices_pricingMarketId_idx`(`pricingMarketId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `countries`
  ADD CONSTRAINT `countries_pricingMarketId_fkey`
  FOREIGN KEY (`pricingMarketId`) REFERENCES `pricing_markets`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `package_market_prices`
  ADD CONSTRAINT `package_market_prices_packageId_fkey`
  FOREIGN KEY (`packageId`) REFERENCES `packages`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `package_market_prices`
  ADD CONSTRAINT `package_market_prices_pricingMarketId_fkey`
  FOREIGN KEY (`pricingMarketId`) REFERENCES `pricing_markets`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
