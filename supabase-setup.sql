-- ═══════════════════════════════════════════════════════════════
-- OneVoice IVR — Logging & Outcome Tracking
-- Run this in Supabase SQL Editor (https://supabase.com/dashboard)
-- ═══════════════════════════════════════════════════════════════

-- 1. Calls table — one row per phone call
CREATE TABLE IF NOT EXISTS calls (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_sid      TEXT UNIQUE NOT NULL,
  from_number   TEXT,
  mode          TEXT CHECK (mode IN ('dental', 'agri', 'unknown')),
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  ended_at      TIMESTAMPTZ,
  duration_sec  INTEGER,
  total_turns   INTEGER DEFAULT 0,
  outcome_score INTEGER CHECK (outcome_score IN (1, 2, 3)),  -- 1=useful, 2=not useful, 3=no response
  outcome_text  TEXT,
  language      TEXT DEFAULT 'ro',
  status        TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed', 'abandoned'))
);

-- 2. Conversation turns — every user/assistant exchange
CREATE TABLE IF NOT EXISTS conversation_turns (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_sid      TEXT NOT NULL REFERENCES calls(call_sid) ON DELETE CASCADE,
  turn_number   INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content       TEXT NOT NULL,
  confidence    REAL,  -- Twilio speech confidence (0-1)
  tokens_used   INTEGER,
  latency_ms    INTEGER,  -- time to get AI response
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Daily aggregates — for quick dashboard
CREATE TABLE IF NOT EXISTS daily_stats (
  date          DATE PRIMARY KEY DEFAULT CURRENT_DATE,
  total_calls   INTEGER DEFAULT 0,
  dental_calls  INTEGER DEFAULT 0,
  agri_calls    INTEGER DEFAULT 0,
  avg_turns     REAL DEFAULT 0,
  avg_duration  REAL DEFAULT 0,
  positive_outcomes INTEGER DEFAULT 0,
  negative_outcomes INTEGER DEFAULT 0,
  no_response_outcomes INTEGER DEFAULT 0
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_mode ON calls(mode);
CREATE INDEX IF NOT EXISTS idx_turns_call ON conversation_turns(call_sid);

-- RLS: disable for now (server-side only access)
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_stats ENABLE ROW LEVEL SECURITY;

-- Allow service_role full access
CREATE POLICY IF NOT EXISTS "service_role_calls" ON calls FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "service_role_turns" ON conversation_turns FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "service_role_stats" ON daily_stats FOR ALL USING (true) WITH CHECK (true);
