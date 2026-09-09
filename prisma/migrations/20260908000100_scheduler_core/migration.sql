CREATE TABLE `schedule_recurrence_rules` (
    `id` VARCHAR(191) NOT NULL,
    `frequency` VARCHAR(191) NOT NULL,
    `interval` INTEGER NOT NULL DEFAULT 1,
    `daysOfWeek` TEXT NULL,
    `dayOfMonth` INTEGER NULL,
    `monthOfYear` INTEGER NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NULL,
    `count` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `schedule_recurrence_rules_frequency_idx`(`frequency`),
    INDEX `schedule_recurrence_rules_startsAt_idx`(`startsAt`),
    INDEX `schedule_recurrence_rules_endsAt_idx`(`endsAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `scheduled_events` (
    `id` VARCHAR(191) NOT NULL,
    `ministryId` VARCHAR(191) NOT NULL,
    `churchId` VARCHAR(191) NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `type` VARCHAR(191) NOT NULL,
    `sourceModule` VARCHAR(191) NOT NULL,
    `sourceId` VARCHAR(191) NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `timezone` VARCHAR(191) NOT NULL DEFAULT 'UTC',
    `locationText` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'scheduled',
    `approvalStatus` VARCHAR(191) NOT NULL DEFAULT 'not_required',
    `organizerUserId` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NULL,
    `recurrenceRuleId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `scheduled_events_ministryId_startAt_idx`(`ministryId`, `startAt`),
    INDEX `scheduled_events_churchId_startAt_idx`(`churchId`, `startAt`),
    UNIQUE INDEX `scheduled_events_source_key`(`sourceModule`, `sourceId`),
    INDEX `scheduled_events_type_status_idx`(`type`, `status`),
    INDEX `scheduled_events_approvalStatus_idx`(`approvalStatus`),
    INDEX `scheduled_events_organizerUserId_idx`(`organizerUserId`),
    INDEX `scheduled_events_recurrenceRuleId_idx`(`recurrenceRuleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `events` ADD COLUMN `recurrenceRuleId` VARCHAR(191) NULL;
CREATE INDEX `events_recurrenceRuleId_idx` ON `events`(`recurrenceRuleId`);

ALTER TABLE `cell_meetings` ADD COLUMN `time` VARCHAR(191) NULL;
ALTER TABLE `cell_meetings` ADD COLUMN `recurrenceRuleId` VARCHAR(191) NULL;
CREATE INDEX `cell_meetings_recurrenceRuleId_idx` ON `cell_meetings`(`recurrenceRuleId`);
