-- 0002: decision engine storage.
--
-- An ad decision is made for every screen every slot (15 s). Storing each slot with its full evidence would
-- be ~1 million rows a day, so:
-- - decision_contexts: the crowd profile, evidence, candidate scores and AI verification, stored once per
--   change of a screen's inputs (crowd window, flight event, settings).
-- - decisions: one row per run of consecutive slots playing the same campaign from the same context.
-- - impressions: aggregated per screen, campaign, creative and 5-minute window.

CREATE TABLE decision_contexts (
  id text PRIMARY KEY,
  screen_id text NOT NULL,
  computed_at timestamptz NOT NULL,
  window_start timestamptz NOT NULL,
  crowd jsonb NOT NULL,
  profile jsonb NOT NULL,
  evidence jsonb NOT NULL,
  candidates jsonb NOT NULL,
  ai jsonb NOT NULL
);
CREATE INDEX decision_contexts_screen_time_idx ON decision_contexts (screen_id, computed_at);

ALTER TABLE decisions DROP COLUMN profile;
ALTER TABLE decisions DROP COLUMN candidates;
ALTER TABLE decisions DROP COLUMN evidence;
ALTER TABLE decisions ADD COLUMN context_id text NOT NULL;
ALTER TABLE decisions ADD COLUMN slot_end timestamptz NOT NULL;
ALTER TABLE decisions ADD COLUMN slots integer NOT NULL;
ALTER TABLE decisions ADD COLUMN rules jsonb NOT NULL;
CREATE INDEX decisions_context_idx ON decisions (context_id);

ALTER TABLE impressions ADD COLUMN plays integer NOT NULL;
ALTER TABLE impressions ADD COLUMN window_start timestamptz NOT NULL;
CREATE UNIQUE INDEX impressions_window_uidx ON impressions (screen_id, campaign_id, creative_id, window_start);

-- Learning: per-campaign, per-segment outcome counters, and the trained model versions.
CREATE TABLE campaign_segment_stats (
  campaign_id text NOT NULL,
  segment text NOT NULL,
  viewers double precision NOT NULL,
  scans integer NOT NULL,
  redemptions integer NOT NULL,
  revenue double precision NOT NULL,
  PRIMARY KEY (campaign_id, segment)
);

CREATE TABLE model_versions (
  version text PRIMARY KEY,
  trained_at timestamptz NOT NULL,
  performance jsonb NOT NULL,
  segment_rates jsonb NOT NULL,
  notes text NOT NULL
);
CREATE INDEX model_versions_time_idx ON model_versions (trained_at);

-- Media Manager pins: play a campaign on a screen for a period, with a reason.
CREATE TABLE manual_pins (
  id text PRIMARY KEY,
  screen_id text NOT NULL,
  campaign_id text NOT NULL REFERENCES campaigns (id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX manual_pins_screen_idx ON manual_pins (screen_id, starts_at);
