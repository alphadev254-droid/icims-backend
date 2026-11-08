ALTER TABLE `discipleship_courses` ADD COLUMN `churchIds` JSON NULL;
UPDATE `discipleship_courses` SET `churchIds` = JSON_ARRAY(`churchId`) WHERE `churchIds` IS NULL;
ALTER TABLE `discipleship_courses` MODIFY `churchIds` JSON NOT NULL;

CREATE TABLE `discipleship_requirement_definitions` (
  `id` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `churchIds` JSON NOT NULL,
  `type` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'published',
  `passScore` DOUBLE NULL,
  `maxScore` DOUBLE NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `disc_req_defs_admin_type_status_idx` (`ministryAdminId`, `type`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_catalog_assignments` (
  `id` VARCHAR(191) NOT NULL,
  `itemType` VARCHAR(191) NOT NULL,
  `itemId` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `disc_catalog_assignment_item_church_key` (`itemType`, `itemId`, `churchId`),
  INDEX `disc_catalog_assignment_church_user_idx` (`churchId`, `userId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `discipleship_workflow_requirements` ADD COLUMN `definitionId` VARCHAR(191) NULL;
ALTER TABLE `discipleship_workflow_requirements` ADD INDEX `disc_wf_req_definition_idx` (`definitionId`);
ALTER TABLE `discipleship_journey_requirements` ADD COLUMN `definitionId` VARCHAR(191) NULL;
ALTER TABLE `discipleship_journey_requirements` ADD COLUMN `assessmentScore` DOUBLE NULL;
ALTER TABLE `discipleship_journey_requirements` ADD COLUMN `assessmentPassed` BOOLEAN NULL;
ALTER TABLE `discipleship_journey_requirements` ADD INDEX `disc_journey_req_definition_idx` (`definitionId`);
