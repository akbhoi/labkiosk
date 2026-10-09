-- Mail's Deleted folder.
--
-- Deleting a mail conversation in the Super Admin console used to remove it,
-- its messages and their stored originals at once. It now moves to Deleted
-- first (`deleted_at` set), where it can be restored or removed for good.
-- NULL means it is not deleted; tasks are never deleted, so theirs stays NULL.

ALTER TABLE conversations ADD COLUMN deleted_at INTEGER;
