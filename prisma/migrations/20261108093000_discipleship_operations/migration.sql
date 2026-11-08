CREATE TABLE `discipleship_courses` (
  `id` VARCHAR(191) NOT NULL, `ministryAdminId` VARCHAR(191) NOT NULL, `churchId` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL, `description` TEXT NULL, `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
  `createdById` VARCHAR(191) NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  INDEX `discipleship_courses_churchId_status_idx` (`churchId`, `status`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_course_materials` (
  `id` VARCHAR(191) NOT NULL, `courseId` VARCHAR(191) NOT NULL, `title` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(191) NOT NULL DEFAULT 'document', `url` VARCHAR(191) NULL, `content` TEXT NULL,
  `position` INTEGER NOT NULL DEFAULT 1, `downloadable` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `discipleship_course_materials_courseId_position_idx` (`courseId`, `position`), PRIMARY KEY (`id`),
  CONSTRAINT `discipleship_course_materials_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `discipleship_courses` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_classes` (
  `id` VARCHAR(191) NOT NULL, `courseId` VARCHAR(191) NOT NULL, `churchId` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL, `facilitatorId` VARCHAR(191) NULL, `location` VARCHAR(191) NULL,
  `startsAt` DATETIME(3) NOT NULL, `endsAt` DATETIME(3) NULL, `capacity` INTEGER NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'scheduled', `reminderMinutes` INTEGER NOT NULL DEFAULT 1440,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  INDEX `discipleship_classes_churchId_startsAt_status_idx` (`churchId`, `startsAt`, `status`), PRIMARY KEY (`id`),
  CONSTRAINT `discipleship_classes_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `discipleship_courses` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_class_sessions` (
  `id` VARCHAR(191) NOT NULL, `classId` VARCHAR(191) NOT NULL, `title` VARCHAR(191) NOT NULL,
  `startsAt` DATETIME(3) NOT NULL, `endsAt` DATETIME(3) NULL, `location` VARCHAR(191) NULL,
  `checkInCode` VARCHAR(191) NOT NULL, `status` VARCHAR(191) NOT NULL DEFAULT 'scheduled',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `discipleship_class_sessions_checkInCode_key` (`checkInCode`),
  INDEX `discipleship_class_sessions_classId_startsAt_idx` (`classId`, `startsAt`), PRIMARY KEY (`id`),
  CONSTRAINT `discipleship_class_sessions_classId_fkey` FOREIGN KEY (`classId`) REFERENCES `discipleship_classes` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_class_enrollments` (
  `id` VARCHAR(191) NOT NULL, `classId` VARCHAR(191) NOT NULL, `journeyId` VARCHAR(191) NOT NULL,
  `requirementId` VARCHAR(191) NULL, `status` VARCHAR(191) NOT NULL DEFAULT 'enrolled',
  `enrolledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `completedAt` DATETIME(3) NULL,
  UNIQUE INDEX `discipleship_class_enrollments_classId_journeyId_key` (`classId`, `journeyId`),
  INDEX `discipleship_class_enrollments_journeyId_status_idx` (`journeyId`, `status`), PRIMARY KEY (`id`),
  CONSTRAINT `discipleship_class_enrollments_classId_fkey` FOREIGN KEY (`classId`) REFERENCES `discipleship_classes` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_session_attendance` (
  `id` VARCHAR(191) NOT NULL, `sessionId` VARCHAR(191) NOT NULL, `enrollmentId` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'present', `method` VARCHAR(191) NOT NULL DEFAULT 'manual',
  `checkedInAt` DATETIME(3) NULL, `recordedById` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `discipleship_session_attendance_sessionId_enrollmentId_key` (`sessionId`, `enrollmentId`),
  INDEX `discipleship_session_attendance_sessionId_status_idx` (`sessionId`, `status`), PRIMARY KEY (`id`),
  CONSTRAINT `discipleship_session_attendance_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `discipleship_class_sessions` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `discipleship_session_attendance_enrollmentId_fkey` FOREIGN KEY (`enrollmentId`) REFERENCES `discipleship_class_enrollments` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_mentor_assignments` (
  `id` VARCHAR(191) NOT NULL, `journeyId` VARCHAR(191) NOT NULL, `mentorUserId` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'active', `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `nextFollowUpAt` DATETIME(3) NULL, `endedAt` DATETIME(3) NULL, `assignedById` VARCHAR(191) NOT NULL,
  INDEX `discipleship_mentor_assignments_journeyId_status_idx` (`journeyId`, `status`),
  INDEX `discipleship_mentor_assignments_mentorUserId_status_idx` (`mentorUserId`, `status`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_mentor_interactions` (
  `id` VARCHAR(191) NOT NULL, `assignmentId` VARCHAR(191) NOT NULL, `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `notes` TEXT NOT NULL, `concernFlag` BOOLEAN NOT NULL DEFAULT false, `createdById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `discipleship_mentor_interactions_assignmentId_occurredAt_idx` (`assignmentId`, `occurredAt`), PRIMARY KEY (`id`),
  CONSTRAINT `discipleship_mentor_interactions_assignmentId_fkey` FOREIGN KEY (`assignmentId`) REFERENCES `discipleship_mentor_assignments` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_milestone_records` (
  `id` VARCHAR(191) NOT NULL, `journeyId` VARCHAR(191) NOT NULL, `requirementId` VARCHAR(191) NOT NULL,
  `milestoneDate` DATETIME(3) NOT NULL, `location` VARCHAR(191) NULL, `officiant` VARCHAR(191) NULL,
  `evidenceUrl` VARCHAR(191) NULL, `notes` TEXT NULL, `completedById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `discipleship_milestone_records_requirementId_key` (`requirementId`),
  INDEX `discipleship_milestone_records_journeyId_milestoneDate_idx` (`journeyId`, `milestoneDate`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_assessments` (
  `id` VARCHAR(191) NOT NULL, `courseId` VARCHAR(191) NULL, `churchId` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL, `description` TEXT NULL, `passScore` DOUBLE NOT NULL DEFAULT 70,
  `maxScore` DOUBLE NOT NULL DEFAULT 100, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `discipleship_assessments_churchId_createdAt_idx` (`churchId`, `createdAt`), PRIMARY KEY (`id`),
  CONSTRAINT `discipleship_assessments_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `discipleship_courses` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_assessment_results` (
  `id` VARCHAR(191) NOT NULL, `assessmentId` VARCHAR(191) NOT NULL, `journeyId` VARCHAR(191) NOT NULL,
  `requirementId` VARCHAR(191) NULL, `score` DOUBLE NOT NULL, `passed` BOOLEAN NOT NULL,
  `notes` TEXT NULL, `gradedById` VARCHAR(191) NOT NULL, `gradedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `discipleship_assessment_results_journeyId_gradedAt_idx` (`journeyId`, `gradedAt`), PRIMARY KEY (`id`),
  CONSTRAINT `discipleship_assessment_results_assessmentId_fkey` FOREIGN KEY (`assessmentId`) REFERENCES `discipleship_assessments` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_placements` (
  `id` VARCHAR(191) NOT NULL, `journeyId` VARCHAR(191) NOT NULL, `teamId` VARCHAR(191) NULL, `cellId` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'planned', `placedAt` DATETIME(3) NULL, `placedById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `discipleship_placements_journeyId_key` (`journeyId`),
  INDEX `discipleship_placements_teamId_status_idx` (`teamId`, `status`),
  INDEX `discipleship_placements_cellId_status_idx` (`cellId`, `status`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_notification_logs` (
  `id` VARCHAR(191) NOT NULL, `key` VARCHAR(191) NOT NULL, `churchId` VARCHAR(191) NOT NULL,
  `journeyId` VARCHAR(191) NULL, `sessionId` VARCHAR(191) NULL, `type` VARCHAR(191) NOT NULL,
  `channel` VARCHAR(191) NOT NULL DEFAULT 'push', `recipientId` VARCHAR(191) NOT NULL,
  `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE INDEX `discipleship_notification_logs_key_key` (`key`),
  INDEX `discipleship_notification_logs_churchId_type_sentAt_idx` (`churchId`, `type`, `sentAt`),
  INDEX `discipleship_notification_logs_journeyId_sentAt_idx` (`journeyId`, `sentAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `discipleship_belonging_prompts` (
  `id` VARCHAR(191) NOT NULL, `churchId` VARCHAR(191) NOT NULL, `sourceType` VARCHAR(191) NOT NULL DEFAULT 'attendance',
  `sourceRecordId` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `email` VARCHAR(191) NULL, `phone` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'pending', `promptedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `respondedAt` DATETIME(3) NULL, `assignedToId` VARCHAR(191) NULL, `notes` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `discipleship_belonging_prompts_churchId_sourceType_sourceRecordId_key` (`churchId`, `sourceType`, `sourceRecordId`),
  INDEX `discipleship_belonging_prompts_churchId_status_promptedAt_idx` (`churchId`, `status`, `promptedAt`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `permissions` (`id`, `name`, `resource`, `action`) VALUES
  (UUID(), 'discipleship_courses:read', 'discipleship_courses', 'read'),
  (UUID(), 'discipleship_courses:manage', 'discipleship_courses', 'manage'),
  (UUID(), 'discipleship_attendance:manage', 'discipleship_attendance', 'manage'),
  (UUID(), 'discipleship_attendance:checkin', 'discipleship_attendance', 'checkin'),
  (UUID(), 'discipleship_mentors:manage', 'discipleship_mentors', 'manage'),
  (UUID(), 'discipleship_reports:read', 'discipleship_reports', 'read');

INSERT IGNORE INTO `role_permissions` (`ministryAdminId`, `roleId`, `permissionId`)
SELECT 'GLOBAL', r.`id`, p.`id` FROM `roles` r JOIN `permissions` p ON p.`name` IN (
  'discipleship_courses:read', 'discipleship_courses:manage', 'discipleship_attendance:manage',
  'discipleship_attendance:checkin', 'discipleship_mentors:manage', 'discipleship_reports:read'
) WHERE r.`name` = 'ministry_admin';

INSERT IGNORE INTO `role_permissions` (`ministryAdminId`, `roleId`, `permissionId`)
SELECT 'GLOBAL', r.`id`, p.`id` FROM `roles` r JOIN `permissions` p ON p.`name` IN (
  'discipleship_courses:read', 'discipleship_attendance:checkin'
) WHERE r.`name` = 'discipleship_candidate';
