-- 0004: claim links. A promo ad on a screen shows a QR code with a link token; a passenger's phone opens the
-- claim page with it. Share links (family sharing) carry the code they were shared from.
CREATE TABLE claim_links (
  token text PRIMARY KEY,
  screen_id text NOT NULL,
  campaign_id text NOT NULL,
  creative_id text,
  decision_id text,
  flight_id text,
  outlet_id text,
  segment text,
  parent_code text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  opens integer NOT NULL DEFAULT 0,
  claims integer NOT NULL DEFAULT 0
);
CREATE INDEX claim_links_screen_idx ON claim_links (screen_id, created_at);
CREATE INDEX claim_links_parent_idx ON claim_links (parent_code);
