-- ═══════════════════════════════════════════════════════════════════════════════
--  LuaForge v3.1 — Supabase Migration
--  Run this in your Supabase SQL editor.
--  Safe to run on an existing database — uses IF NOT EXISTS everywhere.
--
--  IMPORTANT: This backend uses its own JWT + service-role Supabase key.
--  RLS policies reference a "user_id" column (BIGINT) that matches the backend's
--  JWT payload id — NOT Supabase Auth's auth.uid(). The service-role key bypasses
--  RLS entirely, so policies here serve as documentation + protection if you ever
--  switch to the anon key. If you use Supabase Auth, replace user_id comparisons
--  with auth.uid()::bigint.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 0. USERS TABLE PREREQUISITE ────────────────────────────────────────────
-- This migration assumes the users table already exists with these columns:
--   id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL,
--   password_hash TEXT NOT NULL, is_admin BOOLEAN DEFAULT false,
--   is_banned BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW(),
--   last_seen TIMESTAMPTZ
-- If starting from scratch, run your base migration first (users, script_log, ban_log, ip_bans).

-- ─── 1. SCRIPT VERSION CONTROL ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS script_versions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  script_name TEXT   NOT NULL,
  script_type TEXT   NOT NULL DEFAULT 'Script',  -- Script | LocalScript | ModuleScript
  code        TEXT   NOT NULL,
  description TEXT   NOT NULL DEFAULT '',
  meta        JSONB  NOT NULL DEFAULT '{}',       -- flexible: AI params, tags, etc.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_script_versions_user_name
  ON script_versions(user_id, script_name, created_at DESC);

-- ─── 2. CONSOLE LOG PERSISTENCE ──────────────────────────────────────────────
-- Only errors are persisted; info/print stay in-memory only.

CREATE TABLE IF NOT EXISTS console_logs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level      TEXT   NOT NULL DEFAULT 'error',   -- error | warn | info | print
  message    TEXT   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_console_logs_user
  ON console_logs(user_id, created_at DESC);

-- Auto-prune logs older than 30 days.
-- Enable pg_cron in Supabase dashboard → Extensions, then run:
-- SELECT cron.schedule('luaforge-prune-logs', '0 3 * * *',
--   $$DELETE FROM console_logs WHERE created_at < NOW() - INTERVAL '30 days'$$);
-- SELECT cron.schedule('luaforge-prune-versions', '0 4 * * 0',
--   $$DELETE FROM script_versions WHERE created_at < NOW() - INTERVAL '90 days'
--     AND id NOT IN (
--       SELECT DISTINCT ON (user_id, script_name) id FROM script_versions
--       ORDER BY user_id, script_name, created_at DESC
--     )$$);

-- ─── 3. SELF-LEARNING: LEARNED PATTERNS ──────────────────────────────────────
-- ChromaDB holds the embeddings; this table is for admin review + audit.

CREATE TABLE IF NOT EXISTS learned_patterns (
  id             BIGSERIAL PRIMARY KEY,
  source         TEXT   NOT NULL,   -- 'auto_error' | 'feedback' | 'manual'
  user_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  pattern        TEXT   NOT NULL,
  tags           TEXT   NOT NULL DEFAULT '',
  original_error TEXT,
  meta           JSONB  NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learned_patterns_source
  ON learned_patterns(source, created_at DESC);

-- ─── 4. CODE FEEDBACK ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS code_feedback (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code            TEXT   NOT NULL,
  feedback        TEXT   NOT NULL,
  rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  original_prompt TEXT   NOT NULL DEFAULT '',
  meta            JSONB  NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_code_feedback_user
  ON code_feedback(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_code_feedback_rating
  ON code_feedback(rating, created_at DESC);

-- ─── 5. VERIFY EXISTING TABLES ────────────────────────────────────────────────

ALTER TABLE script_log ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';

-- ─── 6. ROW LEVEL SECURITY (RLS) ─────────────────────────────────────────────
-- NOTE: The backend uses the service-role key which bypasses RLS.
-- These policies protect the tables if you ever use the anon key directly.
-- They compare user_id (BIGINT from our JWT) NOT auth.uid() (Supabase Auth UUID).
-- If you integrate Supabase Auth, update the USING clauses to auth.uid()::bigint.

ALTER TABLE script_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_logs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE learned_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_feedback    ENABLE ROW LEVEL SECURITY;

-- Drop and recreate policies to avoid IF NOT EXISTS issues on older Postgres
DO $$ BEGIN
  DROP POLICY IF EXISTS "users_own_versions"      ON script_versions;
  DROP POLICY IF EXISTS "users_own_console_logs"  ON console_logs;
  DROP POLICY IF EXISTS "patterns_read_all"        ON learned_patterns;
  DROP POLICY IF EXISTS "patterns_write_own"       ON learned_patterns;
  DROP POLICY IF EXISTS "users_own_feedback"       ON code_feedback;
END $$;

-- script_versions: users see only their own
CREATE POLICY "users_own_versions"
  ON script_versions FOR ALL
  USING (user_id = current_setting('app.current_user_id', true)::bigint);

-- console_logs: users see only their own
CREATE POLICY "users_own_console_logs"
  ON console_logs FOR ALL
  USING (user_id = current_setting('app.current_user_id', true)::bigint);

-- learned_patterns: readable by all (global knowledge), writable by owner
CREATE POLICY "patterns_read_all"
  ON learned_patterns FOR SELECT USING (true);

CREATE POLICY "patterns_write_own"
  ON learned_patterns FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::bigint);

-- code_feedback: users see only their own
CREATE POLICY "users_own_feedback"
  ON code_feedback FOR ALL
  USING (user_id = current_setting('app.current_user_id', true)::bigint);

-- ─── 7. FULL-TEXT SEARCH ─────────────────────────────────────────────────────
-- Optional: enables Postgres FTS as a fallback when ChromaDB is down.
-- Use websearch_to_tsquery('english', $1) in queries.

CREATE INDEX IF NOT EXISTS idx_script_versions_fts
  ON script_versions USING gin(to_tsvector('english', coalesce(script_name,'') || ' ' || coalesce(code,'')));

CREATE INDEX IF NOT EXISTS idx_learned_patterns_fts
  ON learned_patterns USING gin(to_tsvector('english', coalesce(pattern,'')));

CREATE INDEX IF NOT EXISTS idx_code_feedback_fts
  ON code_feedback USING gin(to_tsvector('english', coalesce(feedback,'') || ' ' || coalesce(code,'')));

-- ─── 8. SET CURRENT USER SESSION HELPER ──────────────────────────────────────
-- Backend must call this before any non-service-role query for RLS to work:
--   await supabase.rpc('set_current_user_id', { uid: req.user.id })
-- Or use: SET LOCAL app.current_user_id = '<id>'

CREATE OR REPLACE FUNCTION set_current_user_id(uid BIGINT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.current_user_id', uid::text, true);
END;
$$;

-- ─── DONE ─────────────────────────────────────────────────────────────────────
-- New tables: script_versions, console_logs, learned_patterns, code_feedback
-- All tables have a meta JSONB column for flexible future expansion.
-- RLS uses app.current_user_id setting (set by backend on authenticated requests)
-- rather than auth.uid(), matching the custom JWT auth system.

-- ─── 9. MESSAGE COUNT TABLE ───────────────────────────────────────────────────
-- Tracks per-user message counts for admin panel stats.

CREATE TABLE IF NOT EXISTS message_counts (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  count      BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RPC function called by backend to atomically increment count
CREATE OR REPLACE FUNCTION increment_message_count(uid BIGINT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO message_counts (user_id, count, updated_at)
    VALUES (uid, 1, NOW())
  ON CONFLICT (user_id) DO UPDATE
    SET count = message_counts.count + 1, updated_at = NOW();
END;
$$;

-- ─── 10. SCRIPTS GENERATED COUNT ─────────────────────────────────────────────
-- Reuse script_log for scriptsGenerated count — just expose a view for admin.

CREATE OR REPLACE VIEW admin_user_stats AS
SELECT
  u.id,
  u.username,
  u.created_at,
  u.last_seen,
  u.is_banned,
  COALESCE(mc.count, 0) AS messages_count,
  COALESCE(sl.scripts_count, 0) AS scripts_generated
FROM users u
LEFT JOIN message_counts mc ON mc.user_id = u.id
LEFT JOIN (
  SELECT user_id, COUNT(*) AS scripts_count FROM script_log GROUP BY user_id
) sl ON sl.user_id = u.id;

-- ─── 11. FULL-TEXT SEARCH BACKEND HELPER ─────────────────────────────────────
-- Backend can call this to search scripts/patterns when ChromaDB is unavailable.

CREATE OR REPLACE FUNCTION fts_search_scripts(uid BIGINT, query TEXT, lim INT DEFAULT 5)
RETURNS TABLE(id BIGINT, script_name TEXT, code TEXT, created_at TIMESTAMPTZ, rank REAL)
LANGUAGE sql AS $$
  SELECT id, script_name, code, created_at,
    ts_rank(to_tsvector('english', coalesce(script_name,'') || ' ' || coalesce(code,'')),
            websearch_to_tsquery('english', query)) AS rank
  FROM script_versions
  WHERE user_id = uid
    AND to_tsvector('english', coalesce(script_name,'') || ' ' || coalesce(code,''))
        @@ websearch_to_tsquery('english', query)
  ORDER BY rank DESC
  LIMIT lim;
$$;

CREATE OR REPLACE FUNCTION fts_search_patterns(query TEXT, lim INT DEFAULT 10)
RETURNS TABLE(id BIGINT, pattern TEXT, source TEXT, created_at TIMESTAMPTZ, rank REAL)
LANGUAGE sql AS $$
  SELECT id, pattern, source, created_at,
    ts_rank(to_tsvector('english', coalesce(pattern,'')),
            websearch_to_tsquery('english', query)) AS rank
  FROM learned_patterns
  WHERE to_tsvector('english', coalesce(pattern,''))
        @@ websearch_to_tsquery('english', query)
  ORDER BY rank DESC
  LIMIT lim;
$$;
