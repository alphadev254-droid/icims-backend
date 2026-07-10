ALTER TABLE `attendance_participants`
  ADD COLUMN `guestGender` VARCHAR(191) NULL,
  ADD COLUMN `guestAgeBracket` VARCHAR(191) NULL;

CREATE INDEX `attendance_participants_guestGender_idx` ON `attendance_participants`(`guestGender`);
CREATE INDEX `attendance_participants_guestAgeBracket_idx` ON `attendance_participants`(`guestAgeBracket`);
