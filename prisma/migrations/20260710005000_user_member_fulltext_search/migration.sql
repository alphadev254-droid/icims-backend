ALTER TABLE `users`
  ADD FULLTEXT INDEX `users_member_search_fulltext_idx` (`firstName`, `lastName`, `email`, `phone`);
