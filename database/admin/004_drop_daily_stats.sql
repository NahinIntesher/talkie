-- Derived data: every number in daily_stats can be computed from the services' own tables (the admin dashboard
-- does exactly that), so the copy is removed instead of being kept in sync.
DROP TABLE daily_stats;
