-- What a moderator did about a report, and a faster "open reports about this person" lookup.
ALTER TABLE reports
  ADD COLUMN action ENUM('none','suspended','signed_out') NULL AFTER resolution,
  ADD KEY ix_reports_target_status (target_type, target_id, status);
