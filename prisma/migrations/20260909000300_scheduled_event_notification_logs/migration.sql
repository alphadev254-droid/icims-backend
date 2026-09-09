CREATE TABLE `scheduled_event_notification_logs` (
    `id` VARCHAR(191) NOT NULL,
    `scheduledEventId` VARCHAR(191) NOT NULL,
    `scheduledEventOccurrenceId` VARCHAR(191) NULL,
    `reminderType` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(191) NOT NULL,
    `sourceModule` VARCHAR(191) NOT NULL,
    `sourceId` VARCHAR(191) NULL,
    `recipientCount` INTEGER NOT NULL DEFAULT 0,
    `scheduledFor` DATETIME(3) NOT NULL,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `errorMessage` TEXT NULL,

    UNIQUE INDEX `scheduled_event_notification_once`(`scheduledEventId`, `scheduledFor`, `reminderType`, `channel`),
    INDEX `scheduled_event_notification_logs_scheduledEventId_sentAt_idx`(`scheduledEventId`, `sentAt`),
    INDEX `scheduled_event_notification_logs_scheduledEventOccurrenceId_idx`(`scheduledEventOccurrenceId`),
    INDEX `scheduled_event_notification_logs_sourceModule_sourceId_idx`(`sourceModule`, `sourceId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `sched_notif_event_fkey`
      FOREIGN KEY (`scheduledEventId`) REFERENCES `scheduled_events`(`id`)
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `sched_notif_occ_fkey`
      FOREIGN KEY (`scheduledEventOccurrenceId`) REFERENCES `scheduled_event_occurrences`(`id`)
      ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
