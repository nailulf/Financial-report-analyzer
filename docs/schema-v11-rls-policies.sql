-- =============================================================================
-- RLS policies for Phase 6 tables
-- Enables read access for anon key (used by NextJS frontend)
-- Run after schema-v11-ai-pipeline.sql
-- =============================================================================

-- Enable RLS on all Phase 6 tables
ALTER TABLE data_quality_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE normalized_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_context_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sector_templates ENABLE ROW LEVEL SECURITY;

-- Public read access (anon key can SELECT)
CREATE POLICY "Allow public read" ON data_quality_flags FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON normalized_metrics FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON stock_scores FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON ai_context_cache FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON ai_analysis FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON stock_notes FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON sector_templates FOR SELECT USING (true);

-- Public write access for stock_notes and sector_templates (editable via debug panel)
CREATE POLICY "Allow public write" ON stock_notes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public write" ON sector_templates FOR ALL USING (true) WITH CHECK (true);

-- Service role has full access by default (bypasses RLS)
-- Python pipeline uses service role key for writes to all tables
