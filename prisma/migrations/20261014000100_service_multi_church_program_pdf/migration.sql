CREATE TABLE `service_churches` (
  `id` VARCHAR(191) NOT NULL,
  `serviceId` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `service_churches_serviceId_churchId_key` (`serviceId`, `churchId`),
  INDEX `service_churches_churchId_idx` (`churchId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `service_churches` (`id`, `serviceId`, `churchId`, `createdAt`)
SELECT CONCAT('svch_', SUBSTRING(REPLACE(UUID(), '-', ''), 1, 20)), `id`, `churchId`, NOW(3)
FROM `services`
WHERE `churchId` IS NOT NULL;

ALTER TABLE `service_churches`
  ADD CONSTRAINT `service_churches_serviceId_fkey`
  FOREIGN KEY (`serviceId`) REFERENCES `services` (`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `service_churches`
  ADD CONSTRAINT `service_churches_churchId_fkey`
  FOREIGN KEY (`churchId`) REFERENCES `churches` (`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
