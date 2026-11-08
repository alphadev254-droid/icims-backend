CREATE TABLE `discipleship_candidate_profiles` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `owningChurchId` VARCHAR(191) NOT NULL,
  `preferredLanguage` VARCHAR(191) NULL,
  `referralSource` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'active',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `discipleship_candidate_profiles_userId_key`(`userId`),
  INDEX `discipleship_candidate_profiles_ministryAdminId_status_idx`(`ministryAdminId`, `status`),
  INDEX `discipleship_candidate_profiles_owningChurchId_status_idx`(`owningChurchId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_workflows` (
  `id` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
  `version` INTEGER NOT NULL DEFAULT 1,
  `isDefault` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `discipleship_workflows_churchId_name_version_key`(`churchId`, `name`, `version`),
  INDEX `discipleship_workflows_ministryAdminId_status_idx`(`ministryAdminId`, `status`),
  INDEX `discipleship_workflows_churchId_status_isDefault_idx`(`churchId`, `status`, `isDefault`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_workflow_stages` (
  `id` VARCHAR(191) NOT NULL,
  `workflowId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `position` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `discipleship_workflow_stages_workflowId_position_key`(`workflowId`, `position`),
  INDEX `discipleship_workflow_stages_workflowId_idx`(`workflowId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_workflow_requirements` (
  `id` VARCHAR(191) NOT NULL,
  `stageId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `type` VARCHAR(191) NOT NULL DEFAULT 'checklist',
  `isRequired` BOOLEAN NOT NULL DEFAULT true,
  `position` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `discipleship_workflow_requirements_stageId_position_key`(`stageId`, `position`),
  INDEX `discipleship_workflow_requirements_stageId_idx`(`stageId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_intakes` (
  `id` VARCHAR(191) NOT NULL,
  `candidateId` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `sourceType` VARCHAR(191) NOT NULL DEFAULT 'direct',
  `sourceRecordId` VARCHAR(191) NULL,
  `consentStatus` VARCHAR(191) NOT NULL DEFAULT 'yes',
  `consentAt` DATETIME(3) NULL,
  `consentById` VARCHAR(191) NULL,
  `notes` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `discipleship_intakes_churchId_sourceType_sourceRecordId_key`(`churchId`, `sourceType`, `sourceRecordId`),
  INDEX `discipleship_intakes_candidateId_createdAt_idx`(`candidateId`, `createdAt`),
  INDEX `discipleship_intakes_churchId_consentStatus_createdAt_idx`(`churchId`, `consentStatus`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_journeys` (
  `id` VARCHAR(191) NOT NULL,
  `journeyCode` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `candidateId` VARCHAR(191) NOT NULL,
  `candidateUserId` VARCHAR(191) NOT NULL,
  `workflowId` VARCHAR(191) NOT NULL,
  `currentStageId` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'active',
  `progressPercent` INTEGER NOT NULL DEFAULT 0,
  `version` INTEGER NOT NULL DEFAULT 1,
  `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedAt` DATETIME(3) NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `discipleship_journeys_journeyCode_key`(`journeyCode`),
  INDEX `discipleship_journeys_ministryAdminId_createdAt_idx`(`ministryAdminId`, `createdAt`),
  INDEX `discipleship_journeys_churchId_status_updatedAt_idx`(`churchId`, `status`, `updatedAt`),
  INDEX `discipleship_journeys_candidateUserId_status_idx`(`candidateUserId`, `status`),
  INDEX `discipleship_journeys_workflowId_status_idx`(`workflowId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_journey_stages` (
  `id` VARCHAR(191) NOT NULL,
  `journeyId` VARCHAR(191) NOT NULL,
  `sourceStageId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `position` INTEGER NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'not_started',
  `startedAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `discipleship_journey_stages_journeyId_position_key`(`journeyId`, `position`),
  UNIQUE INDEX `discipleship_journey_stages_journeyId_sourceStageId_key`(`journeyId`, `sourceStageId`),
  INDEX `discipleship_journey_stages_journeyId_status_idx`(`journeyId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_journey_requirements` (
  `id` VARCHAR(191) NOT NULL,
  `journeyStageId` VARCHAR(191) NOT NULL,
  `sourceRequirementId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `type` VARCHAR(191) NOT NULL DEFAULT 'checklist',
  `isRequired` BOOLEAN NOT NULL DEFAULT true,
  `position` INTEGER NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
  `completedById` VARCHAR(191) NULL,
  `completionNote` TEXT NULL,
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `discipleship_journey_requirements_stage_source_key`(`journeyStageId`, `sourceRequirementId`),
  INDEX `discipleship_journey_requirements_stage_status_idx`(`journeyStageId`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_audit_events` (
  `id` VARCHAR(191) NOT NULL,
  `ministryAdminId` VARCHAR(191) NOT NULL,
  `churchId` VARCHAR(191) NOT NULL,
  `journeyId` VARCHAR(191) NULL,
  `actorUserId` VARCHAR(191) NOT NULL,
  `action` VARCHAR(191) NOT NULL,
  `entityType` VARCHAR(191) NOT NULL,
  `entityId` VARCHAR(191) NOT NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `discipleship_audit_events_church_entity_created_idx`(`churchId`, `entityType`, `entityId`, `createdAt`),
  INDEX `discipleship_audit_events_journeyId_createdAt_idx`(`journeyId`, `createdAt`),
  INDEX `discipleship_audit_events_actorUserId_createdAt_idx`(`actorUserId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `discipleship_candidate_profiles` ADD CONSTRAINT `discipleship_candidate_profiles_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `discipleship_candidate_profiles` ADD CONSTRAINT `discipleship_candidate_profiles_church_fkey` FOREIGN KEY (`owningChurchId`) REFERENCES `churches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `discipleship_workflows` ADD CONSTRAINT `discipleship_workflows_churchId_fkey` FOREIGN KEY (`churchId`) REFERENCES `churches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `discipleship_workflow_stages` ADD CONSTRAINT `discipleship_workflow_stages_workflowId_fkey` FOREIGN KEY (`workflowId`) REFERENCES `discipleship_workflows`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `discipleship_workflow_requirements` ADD CONSTRAINT `discipleship_workflow_requirements_stageId_fkey` FOREIGN KEY (`stageId`) REFERENCES `discipleship_workflow_stages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `discipleship_intakes` ADD CONSTRAINT `discipleship_intakes_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `discipleship_candidate_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `discipleship_journeys` ADD CONSTRAINT `discipleship_journeys_churchId_fkey` FOREIGN KEY (`churchId`) REFERENCES `churches`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `discipleship_journeys` ADD CONSTRAINT `discipleship_journeys_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `discipleship_candidate_profiles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `discipleship_journeys` ADD CONSTRAINT `discipleship_journeys_candidateUserId_fkey` FOREIGN KEY (`candidateUserId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `discipleship_journeys` ADD CONSTRAINT `discipleship_journeys_workflowId_fkey` FOREIGN KEY (`workflowId`) REFERENCES `discipleship_workflows`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `discipleship_journeys` ADD CONSTRAINT `discipleship_journeys_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `discipleship_journey_stages` ADD CONSTRAINT `discipleship_journey_stages_journeyId_fkey` FOREIGN KEY (`journeyId`) REFERENCES `discipleship_journeys`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `discipleship_journey_requirements` ADD CONSTRAINT `discipleship_journey_requirements_stageId_fkey` FOREIGN KEY (`journeyStageId`) REFERENCES `discipleship_journey_stages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `discipleship_audit_events` ADD CONSTRAINT `discipleship_audit_events_journeyId_fkey` FOREIGN KEY (`journeyId`) REFERENCES `discipleship_journeys`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `discipleship_audit_events` ADD CONSTRAINT `discipleship_audit_events_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
