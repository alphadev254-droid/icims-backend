ALTER TABLE `attendance`
  ADD COLUMN `newConverts` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `attendance_participants`
  ADD COLUMN `guestResidentialArea` VARCHAR(191) NULL,
  ADD COLUMN `guestHowHeard` VARCHAR(191) NULL,
  ADD COLUMN `guestNotes` TEXT NULL,
  ADD COLUMN `invitedByUserId` VARCHAR(191) NULL,
  ADD COLUMN `isNewConvert` BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX `attendance_participants_invitedByUserId_idx`
  ON `attendance_participants`(`invitedByUserId`);

CREATE INDEX `attendance_participants_isNewConvert_idx`
  ON `attendance_participants`(`isNewConvert`);

UPDATE `attendance_participants` p
LEFT JOIN `users` u ON u.`id` = p.`invitedByUserId`
SET p.`invitedByUserId` = NULL
WHERE p.`invitedByUserId` IS NOT NULL
  AND u.`id` IS NULL;

ALTER TABLE `attendance_participants`
  ADD CONSTRAINT `attendance_participants_invitedByUserId_fkey`
  FOREIGN KEY (`invitedByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `cell_attendance`
  ADD COLUMN `isNewConvert` BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX `cell_attendance_isNewConvert_idx`
  ON `cell_attendance`(`isNewConvert`);

CREATE INDEX `cell_attendance_invitedByUserId_idx`
  ON `cell_attendance`(`invitedByUserId`);

UPDATE `cell_attendance` ca
LEFT JOIN `users` u ON u.`id` = ca.`invitedByUserId`
SET ca.`invitedByUserId` = NULL
WHERE ca.`invitedByUserId` IS NOT NULL
  AND u.`id` IS NULL;

ALTER TABLE `cell_attendance`
  ADD CONSTRAINT `cell_attendance_invitedByUserId_fkey`
  FOREIGN KEY (`invitedByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO `attendance_participants` (
  `id`,
  `attendanceId`,
  `guestName`,
  `guestEmail`,
  `guestPhone`,
  `guestGender`,
  `guestAgeBracket`,
  `guestResidentialArea`,
  `guestHowHeard`,
  `guestNotes`,
  `guestFirstTime`,
  `checkInMethod`,
  `status`,
  `checkedInAt`,
  `createdAt`,
  `updatedAt`
)
SELECT
  v.`id`,
  v.`attendanceId`,
  v.`name`,
  v.`email`,
  v.`phone`,
  v.`gender`,
  v.`ageBracket`,
  v.`residentialArea`,
  v.`howHeard`,
  v.`notes`,
  false,
  'legacy_visitor',
  'present',
  v.`createdAt`,
  v.`createdAt`,
  NOW()
FROM `attendance_visitors` v
WHERE NOT EXISTS (
  SELECT 1
  FROM `attendance_participants` p
  WHERE p.`attendanceId` = v.`attendanceId`
    AND (
      (v.`phone` IS NOT NULL AND v.`phone` <> '' AND p.`guestPhone` = v.`phone`)
      OR (v.`email` IS NOT NULL AND v.`email` <> '' AND p.`guestEmail` = v.`email`)
      OR ((v.`phone` IS NULL OR v.`phone` = '') AND (v.`email` IS NULL OR v.`email` = '') AND p.`guestName` = v.`name`)
    )
);

DELETE v
FROM `attendance_visitors` v
WHERE EXISTS (
  SELECT 1
  FROM `attendance_participants` p
  WHERE p.`attendanceId` = v.`attendanceId`
    AND (
      p.`id` = v.`id`
      OR (v.`phone` IS NOT NULL AND v.`phone` <> '' AND p.`guestPhone` = v.`phone`)
      OR (v.`email` IS NOT NULL AND v.`email` <> '' AND p.`guestEmail` = v.`email`)
      OR ((v.`phone` IS NULL OR v.`phone` = '') AND (v.`email` IS NULL OR v.`email` = '') AND p.`guestName` = v.`name`)
    )
);
