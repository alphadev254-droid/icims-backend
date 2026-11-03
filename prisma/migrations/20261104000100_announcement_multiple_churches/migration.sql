CREATE TABLE `announcement_churches` (
    `id` VARCHAR(191) NOT NULL,
    `announcementId` VARCHAR(191) NOT NULL,
    `churchId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    UNIQUE INDEX `announcement_churches_announcementId_churchId_key` (`announcementId`, `churchId`),
    INDEX `announcement_churches_churchId_idx` (`churchId`),
    CONSTRAINT `announcement_churches_announcementId_fkey`
        FOREIGN KEY (`announcementId`) REFERENCES `announcements` (`id`)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `announcement_churches_churchId_fkey`
        FOREIGN KEY (`churchId`) REFERENCES `churches` (`id`)
        ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `announcement_churches` (`id`, `announcementId`, `churchId`, `createdAt`)
SELECT CONCAT('announcement_church_', `id`), `id`, `churchId`, CURRENT_TIMESTAMP(3)
FROM `announcements`;
