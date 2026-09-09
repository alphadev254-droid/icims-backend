CREATE TABLE `scheduled_event_occurrences` (
    `id` VARCHAR(191) NOT NULL,
    `scheduledEventId` VARCHAR(191) NOT NULL,
    `occurrenceStartAt` DATETIME(3) NOT NULL,
    `occurrenceEndAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `generatedSourceModule` VARCHAR(191) NULL,
    `generatedSourceId` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `scheduled_event_occurrence_key`(`scheduledEventId`, `occurrenceStartAt`),
    INDEX `scheduled_event_occurrences_scheduledEventId_status_idx`(`scheduledEventId`, `status`),
    INDEX `scheduled_event_occ_generated_idx`(`generatedSourceModule`, `generatedSourceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
