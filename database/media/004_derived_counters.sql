-- 3NF: upload progress and per-person storage use were stored totals of other rows.
--   media_objects.parts_received / bytes_received  = COUNT / SUM of upload_parts for that file
--   storage_usage.bytes_used                        = SUM(byte_size) of that person's finished files
-- Each part row now records its size (and the S3 receipt, when there is one); the totals are computed.

-- Uploads in progress restart from the first part (their old counters cannot be turned into part rows).
DELETE p FROM upload_parts p JOIN media_objects m ON m.id = p.media_id WHERE m.status = 'pending';

ALTER TABLE upload_parts
  ADD COLUMN byte_size INT UNSIGNED NOT NULL AFTER part_number,
  MODIFY COLUMN etag VARCHAR(255) NULL;

ALTER TABLE media_objects
  DROP COLUMN parts_received,
  DROP COLUMN bytes_received,
  ADD KEY ix_media_owner_usage (owner_id, status, purpose, byte_size);

DROP TABLE storage_usage;
