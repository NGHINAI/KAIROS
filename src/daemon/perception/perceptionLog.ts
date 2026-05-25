// src/daemon/perception/perceptionLog.ts
export const PERCEPTION_LOG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS perception_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    event_count     INTEGER NOT NULL,
    verdict_tier1   TEXT    NOT NULL,
    tier1_cost      INTEGER NOT NULL DEFAULT 0,
    tier2_score     REAL,
    tier2_cost      INTEGER NOT NULL DEFAULT 0,
    narrator_fired  INTEGER NOT NULL DEFAULT 0,
    episode_id      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_perception_log_ts ON perception_log(ts);
`
