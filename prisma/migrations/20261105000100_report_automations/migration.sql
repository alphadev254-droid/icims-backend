CREATE TABLE `report_automations` (
    `id` VARCHAR(191) NOT NULL,
    `ministryAdminId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `reportType` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `filters` JSON NOT NULL,
    `periodPreset` VARCHAR(191) NOT NULL,
    `frequency` VARCHAR(191) NOT NULL,
    `dayOfWeek` INTEGER NULL,
    `dayOfMonth` INTEGER NULL,
    `timeOfDay` VARCHAR(191) NOT NULL,
    `timezone` VARCHAR(191) NOT NULL,
    `format` VARCHAR(191) NOT NULL DEFAULT 'xlsx',
    `recipients` JSON NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `nextRunAt` DATETIME(3) NULL,
    `lastRunAt` DATETIME(3) NULL,
    `lastStatus` VARCHAR(191) NULL,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    INDEX `report_automations_ministryAdminId_reportType_idx` (`ministryAdminId`, `reportType`),
    INDEX `report_automations_isActive_nextRunAt_idx` (`isActive`, `nextRunAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `report_automation_runs` (
    `id` VARCHAR(191) NOT NULL,
    `automationId` VARCHAR(191) NOT NULL,
    `scheduledFor` DATETIME(3) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `recipientCount` INTEGER NOT NULL DEFAULT 0,
    `fileName` VARCHAR(191) NULL,
    `error` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    INDEX `report_automation_runs_automationId_createdAt_idx` (`automationId`, `createdAt`),
    INDEX `report_automation_runs_status_scheduledFor_idx` (`status`, `scheduledFor`),
    CONSTRAINT `report_automation_runs_automationId_fkey`
        FOREIGN KEY (`automationId`) REFERENCES `report_automations` (`id`)
        ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
