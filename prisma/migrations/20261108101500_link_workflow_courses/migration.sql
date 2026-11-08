ALTER TABLE `discipleship_workflow_requirements`
  ADD COLUMN `courseId` VARCHAR(191) NULL,
  ADD COLUMN `classId` VARCHAR(191) NULL,
  ADD INDEX `discipleship_workflow_requirements_courseId_idx` (`courseId`),
  ADD INDEX `discipleship_workflow_requirements_classId_idx` (`classId`);

ALTER TABLE `discipleship_journey_requirements`
  ADD COLUMN `courseId` VARCHAR(191) NULL,
  ADD COLUMN `classId` VARCHAR(191) NULL,
  ADD INDEX `discipleship_journey_requirements_courseId_idx` (`courseId`),
  ADD INDEX `discipleship_journey_requirements_classId_idx` (`classId`);
