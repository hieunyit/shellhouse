-- One summary per operation; object keys and credentials are never stored as a task list.
CREATE TABLE s3_task_history (
  id TEXT PRIMARY KEY,
  record TEXT NOT NULL,
  finished_at INTEGER NOT NULL
);
CREATE INDEX s3_task_history_finished ON s3_task_history(finished_at DESC);
