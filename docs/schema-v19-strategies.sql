-- =============================================================================
-- schema-v19-strategies.sql
-- Strategies: saved screener filter criteria that auto-produce matching stocks.
--
-- A strategy stores a name and a JSONB filter set (same keys as the screener).
-- Matching tickers are evaluated on-the-fly against the stocks table — no
-- materialization needed. Results update daily as scrapers refresh stock data.
--
-- Depends on: schema.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS strategies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  filters    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for listing strategies sorted by creation
CREATE INDEX IF NOT EXISTS idx_strategies_created_at ON strategies (created_at DESC);

-- RLS: personal project, allow full public access via anon key
ALTER TABLE strategies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read"  ON strategies FOR SELECT USING (true);
CREATE POLICY "Allow public write" ON strategies FOR ALL USING (true) WITH CHECK (true);
