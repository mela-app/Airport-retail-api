-- 0003: QR scans per aggregated impression row (scans are counted where the ad played).
ALTER TABLE impressions ADD COLUMN scans integer NOT NULL DEFAULT 0;
