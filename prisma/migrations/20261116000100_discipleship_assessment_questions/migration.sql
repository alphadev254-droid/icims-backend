CREATE TABLE `discipleship_assessment_questions` (
  `id` VARCHAR(191) NOT NULL,
  `definitionId` VARCHAR(191) NOT NULL,
  `prompt` TEXT NOT NULL,
  `type` VARCHAR(191) NOT NULL DEFAULT 'single_choice',
  `options` JSON NOT NULL,
  `correctAnswers` JSON NOT NULL,
  `points` DOUBLE NOT NULL DEFAULT 1,
  `explanation` TEXT NULL,
  `position` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `disc_assess_question_position_key` (`definitionId`, `position`),
  INDEX `disc_assess_question_definition_idx` (`definitionId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_assessment_attempts` (
  `id` VARCHAR(191) NOT NULL,
  `definitionId` VARCHAR(191) NOT NULL,
  `journeyId` VARCHAR(191) NOT NULL,
  `requirementId` VARCHAR(191) NOT NULL,
  `candidateUserId` VARCHAR(191) NOT NULL,
  `score` DOUBLE NOT NULL,
  `pointsEarned` DOUBLE NOT NULL,
  `pointsAvailable` DOUBLE NOT NULL,
  `passed` BOOLEAN NOT NULL,
  `answers` JSON NOT NULL,
  `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `disc_assess_attempt_journey_req_idx` (`journeyId`, `requirementId`, `submittedAt`),
  INDEX `disc_assess_attempt_candidate_idx` (`candidateUserId`, `submittedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `discipleship_assessment_questions`
  ADD CONSTRAINT `disc_assess_question_definition_fk` FOREIGN KEY (`definitionId`) REFERENCES `discipleship_requirement_definitions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `discipleship_assessment_attempts`
  ADD CONSTRAINT `disc_assess_attempt_definition_fk` FOREIGN KEY (`definitionId`) REFERENCES `discipleship_requirement_definitions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `password_reset_tokens`
  ADD COLUMN `purpose` VARCHAR(191) NOT NULL DEFAULT 'password_reset';
