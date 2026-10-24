-- 0001: initial schema. Mirrors apps/api/src/db/schema.ts (checked by test/db.test.ts).

-- airport space (ACRIS)
CREATE TABLE terminals (
  id text PRIMARY KEY,
  name text NOT NULL,
  main_market text NOT NULL,
  outline jsonb NOT NULL
);

CREATE TABLE concourses (
  id text PRIMARY KEY,
  terminal_id text NOT NULL REFERENCES terminals (id),
  name text NOT NULL
);

CREATE TABLE zones (
  id text PRIMARY KEY,
  terminal_id text NOT NULL REFERENCES terminals (id),
  concourse_id text REFERENCES concourses (id),
  name text NOT NULL,
  kind text NOT NULL,
  side text NOT NULL,
  area jsonb NOT NULL
);

CREATE TABLE gates (
  id text PRIMARY KEY,
  code text NOT NULL,
  terminal_id text NOT NULL REFERENCES terminals (id),
  concourse_id text REFERENCES concourses (id),
  zone_id text NOT NULL REFERENCES zones (id),
  remote boolean NOT NULL,
  position jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE checkpoints (
  id text PRIMARY KEY,
  terminal_id text NOT NULL REFERENCES terminals (id),
  zone_id text NOT NULL REFERENCES zones (id),
  name text NOT NULL,
  kind text NOT NULL,
  lanes integer NOT NULL,
  position jsonb NOT NULL
);

CREATE TABLE passenger_queues (
  id text PRIMARY KEY,
  checkpoint_id text NOT NULL REFERENCES checkpoints (id),
  name text NOT NULL,
  queue_type text NOT NULL
);

-- reference data
CREATE TABLE airlines (
  iata text PRIMARY KEY,
  icao text NOT NULL,
  name text NOT NULL,
  model text NOT NULL,
  market text NOT NULL,
  brand_color text NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE aircraft_types (
  icao text PRIMARY KEY,
  name text NOT NULL,
  wide_body boolean NOT NULL,
  cabins jsonb NOT NULL
);

CREATE TABLE destinations (
  iata text PRIMARY KEY,
  city text NOT NULL,
  country text NOT NULL,
  nationality text NOT NULL,
  language text NOT NULL,
  market text NOT NULL,
  region text NOT NULL,
  character text NOT NULL,
  block_minutes integer NOT NULL
);

-- parties and inventory
CREATE TABLE advertisers (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL,
  category text NOT NULL,
  competitor_group text,
  airline_iata text REFERENCES airlines (iata),
  contact_name text NOT NULL,
  contact_email text NOT NULL,
  brand_color text NOT NULL,
  onboarded_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE outlets (
  id text PRIMARY KEY,
  advertiser_id text NOT NULL REFERENCES advertisers (id),
  name text NOT NULL,
  category text NOT NULL,
  terminal_id text NOT NULL REFERENCES terminals (id),
  zone_id text NOT NULL REFERENCES zones (id),
  position jsonb NOT NULL,
  average_basket double precision NOT NULL,
  opened_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE screens (
  id text PRIMARY KEY,
  name text NOT NULL,
  terminal_id text NOT NULL REFERENCES terminals (id),
  zone_id text NOT NULL REFERENCES zones (id),
  position jsonb NOT NULL,
  kind text NOT NULL,
  orientation text NOT NULL,
  size_inches integer NOT NULL,
  resolution text NOT NULL,
  nearest_gate_ids jsonb NOT NULL,
  base_price_per_slot double precision NOT NULL,
  status text NOT NULL,
  status_since timestamptz,
  last_heartbeat timestamptz,
  latency_ms integer,
  installed_at timestamptz NOT NULL
);
CREATE INDEX screens_zone_idx ON screens (zone_id);

CREATE TABLE creatives (
  id text PRIMARY KEY,
  advertiser_id text NOT NULL REFERENCES advertisers (id),
  name text NOT NULL,
  template text NOT NULL,
  artwork text NOT NULL,
  palette jsonb NOT NULL,
  content jsonb NOT NULL,
  formats jsonb NOT NULL,
  status text NOT NULL,
  brand_safety jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE campaigns (
  id text PRIMARY KEY,
  advertiser_id text NOT NULL REFERENCES advertisers (id),
  name text NOT NULL,
  objective text NOT NULL,
  status text NOT NULL,
  creative_ids jsonb NOT NULL,
  segment_weights jsonb NOT NULL,
  hard_filters jsonb NOT NULL,
  placement jsonb NOT NULL,
  budget jsonb NOT NULL,
  triggers jsonb NOT NULL,
  promo jsonb,
  airline_priority boolean NOT NULL,
  co_funded_by text REFERENCES advertisers (id),
  competitor_group text,
  performance_index double precision NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE campaign_daily_stats (
  campaign_id text NOT NULL REFERENCES campaigns (id),
  date text NOT NULL,
  plays integer NOT NULL,
  impressions integer NOT NULL,
  scans integer NOT NULL,
  redemptions integer NOT NULL,
  spend double precision NOT NULL,
  revenue double precision NOT NULL,
  redemptions_by_segment jsonb NOT NULL,
  PRIMARY KEY (campaign_id, date)
);

-- flights (canonical)
CREATE TABLE flights (
  id text PRIMARY KEY,
  source_flight_id text,
  linked_flight_id text,
  direction text NOT NULL,
  airline_iata text NOT NULL,
  airline_icao text NOT NULL,
  flight_number text NOT NULL,
  callsign text,
  service_type text NOT NULL,
  nature text NOT NULL,
  origin text NOT NULL,
  destination text NOT NULL,
  via jsonb NOT NULL,
  terminal text NOT NULL,
  scheduled_time timestamptz NOT NULL,
  estimated_time timestamptz,
  estimated_runway_time timestamptz,
  actual_runway_time timestamptz,
  actual_block_time timestamptz,
  tobt timestamptz,
  tsat timestamptz,
  stand text,
  gate text,
  checkin_counters text,
  baggage_belt text,
  aircraft_registration text,
  aircraft_type_icao text NOT NULL,
  seats integer NOT NULL,
  pax integer,
  status text NOT NULL,
  delay_codes jsonb NOT NULL,
  codeshares jsonb NOT NULL,
  handler text,
  last_update timestamptz NOT NULL,
  source jsonb NOT NULL
);
CREATE INDEX flights_scheduled_idx ON flights (scheduled_time);
CREATE INDEX flights_gate_idx ON flights (terminal, gate);

CREATE TABLE flight_events (
  id text PRIMARY KEY,
  flight_id text NOT NULL,
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  changes jsonb NOT NULL,
  sequence integer,
  source jsonb NOT NULL
);
CREATE INDEX flight_events_flight_idx ON flight_events (flight_id);
CREATE INDEX flight_events_time_idx ON flight_events (occurred_at);

CREATE TABLE crowd_profiles (
  flight_id text PRIMARY KEY,
  profile jsonb NOT NULL,
  source text NOT NULL,
  observed_at timestamptz NOT NULL
);

-- ACRIS measurements and derived presence
CREATE TABLE queue_measurements (
  id text PRIMARY KEY,
  queue_id text NOT NULL,
  checkpoint_id text NOT NULL,
  measured_at timestamptz NOT NULL,
  occupancy integer NOT NULL,
  wait_time_sec integer NOT NULL,
  projected_wait_time_sec integer NOT NULL,
  throughput_per_hour integer NOT NULL
);
CREATE INDEX queue_measurements_time_idx ON queue_measurements (measured_at);

CREATE TABLE zone_presence (
  zone_id text NOT NULL,
  window_start timestamptz NOT NULL,
  pax double precision NOT NULL,
  profile jsonb NOT NULL,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (zone_id, window_start)
);

-- delivery, outcomes and operations
CREATE TABLE decisions (
  id text PRIMARY KEY,
  screen_id text NOT NULL,
  slot_start timestamptz NOT NULL,
  decided_at timestamptz NOT NULL,
  mode text NOT NULL,
  campaign_id text,
  creative_id text,
  score double precision,
  profile jsonb NOT NULL,
  candidates jsonb NOT NULL,
  evidence jsonb NOT NULL,
  checks jsonb NOT NULL,
  reason text NOT NULL
);
CREATE INDEX decisions_screen_slot_idx ON decisions (screen_id, slot_start);
CREATE INDEX decisions_campaign_idx ON decisions (campaign_id);

CREATE TABLE impressions (
  id text PRIMARY KEY,
  decision_id text NOT NULL,
  campaign_id text NOT NULL,
  creative_id text NOT NULL,
  screen_id text NOT NULL,
  played_at timestamptz NOT NULL,
  duration_sec double precision NOT NULL,
  estimated_viewers double precision NOT NULL,
  cost double precision NOT NULL
);
CREATE INDEX impressions_campaign_time_idx ON impressions (campaign_id, played_at);

CREATE TABLE promo_codes (
  code text PRIMARY KEY,
  campaign_id text NOT NULL,
  screen_id text NOT NULL,
  flight_id text,
  parent_code text,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL,
  claimed_at timestamptz
);

CREATE TABLE redemptions (
  id text PRIMARY KEY,
  code text NOT NULL,
  campaign_id text NOT NULL,
  outlet_id text,
  screen_id text NOT NULL,
  redeemed_at timestamptz NOT NULL,
  revenue double precision NOT NULL,
  segment text
);
CREATE INDEX redemptions_campaign_time_idx ON redemptions (campaign_id, redeemed_at);

CREATE TABLE incidents (
  id text PRIMARY KEY,
  kind text NOT NULL,
  severity text NOT NULL,
  title text NOT NULL,
  subject text NOT NULL,
  owner text,
  status text NOT NULL,
  raised_at timestamptz NOT NULL,
  resolved_at timestamptz,
  details jsonb NOT NULL
);
CREATE INDEX incidents_status_idx ON incidents (status);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);
