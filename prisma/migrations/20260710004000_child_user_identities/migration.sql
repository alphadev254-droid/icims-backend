ALTER TABLE `users`
  ADD COLUMN `memberType` VARCHAR(191) NOT NULL DEFAULT 'adult',
  ADD COLUMN `loginEnabled` BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE `children`
  ADD COLUMN `userId` VARCHAR(191) NULL;

CREATE INDEX `users_memberType_idx` ON `users`(`memberType`);
CREATE INDEX `users_loginEnabled_idx` ON `users`(`loginEnabled`);
CREATE UNIQUE INDEX `children_userId_key` ON `children`(`userId`);
CREATE INDEX `children_userId_idx` ON `children`(`userId`);

ALTER TABLE `children`
  ADD CONSTRAINT `children_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
