-- Uploads arrive in numbered parts, in order; these track progress so a stopped upload can resume.
ALTER TABLE media_objects
  ADD COLUMN parts_received INT UNSIGNED    NOT NULL DEFAULT 0 AFTER status,
  ADD COLUMN bytes_received BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER parts_received,
  ADD COLUMN s3_upload_id   VARCHAR(255)    NULL AFTER bytes_received;

-- S3 multipart part receipts (the local disk driver does not need them).
CREATE TABLE upload_parts (
  media_id    BIGINT UNSIGNED  NOT NULL,
  part_number INT UNSIGNED     NOT NULL,
  etag        VARCHAR(255)     NOT NULL,
  PRIMARY KEY (media_id, part_number),
  CONSTRAINT fk_upload_parts_media FOREIGN KEY (media_id) REFERENCES media_objects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
