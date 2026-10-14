CREATE TABLE `bookable_resource_churches` (
  `resourceId` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`resourceId`, `churchId`),
  INDEX `bookable_resource_churches_church_idx` (`churchId`),
  CONSTRAINT `bookable_resource_churches_resource_fkey`
    FOREIGN KEY (`resourceId`) REFERENCES `bookable_resources` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `bookable_resource_churches_church_fkey`
    FOREIGN KEY (`churchId`) REFERENCES `churches` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
