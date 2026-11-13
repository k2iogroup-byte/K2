-- Module 04 market-data storage.
-- Latest quote per instrument, aggregated bars, and feed-status events.
-- Raw ticks are not stored. No provider credentials are stored.

CREATE TABLE instruments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market text NOT NULL,
  venue text NOT NULL,
  symbol text NOT NULL,
  provider_symbol text NOT NULL,
  price_scale integer NOT NULL,
  quantity_scale integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instruments_symbol_unique UNIQUE (symbol),
  CONSTRAINT instruments_provider_symbol_unique UNIQUE (provider_symbol),
  CONSTRAINT instruments_market_check CHECK (market IN ('EQUITIES', 'CRYPTO')),
  CONSTRAINT instruments_venue_check CHECK (venue IN ('NYSE', 'NASDAQ', 'BINANCE_SPOT')),
  CONSTRAINT instruments_market_venue_check CHECK (
    (market = 'EQUITIES' AND venue IN ('NYSE', 'NASDAQ'))
    OR (market = 'CRYPTO' AND venue = 'BINANCE_SPOT')
  ),
  CONSTRAINT instruments_scale_check CHECK (
    price_scale BETWEEN 0 AND 8 AND quantity_scale BETWEEN 0 AND 8
  ),
  CONSTRAINT instruments_symbol_check CHECK (symbol ~ '^[A-Z0-9][A-Z0-9.-]{0,31}$'),
  CONSTRAINT instruments_provider_symbol_check CHECK (
    provider_symbol = lower(provider_symbol) AND char_length(provider_symbol) BETWEEN 1 AND 64
  )
);

CREATE TABLE quote_snapshots (
  instrument_id uuid PRIMARY KEY REFERENCES instruments (id) ON DELETE RESTRICT,
  bid numeric(24, 8) NOT NULL,
  ask numeric(24, 8) NOT NULL,
  bid_size numeric(24, 8) NOT NULL,
  ask_size numeric(24, 8) NOT NULL,
  last_price numeric(24, 8),
  source_timestamp timestamptz NOT NULL,
  received_timestamp timestamptz NOT NULL,
  processed_timestamp timestamptz NOT NULL,
  sequence_no bigint NOT NULL,
  provider_event_id text NOT NULL,
  price_origin text NOT NULL,
  feed_state text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_snapshots_prices_check CHECK (bid > 0 AND ask > 0 AND bid <= ask),
  CONSTRAINT quote_snapshots_sizes_check CHECK (bid_size >= 0 AND ask_size >= 0),
  CONSTRAINT quote_snapshots_origin_check CHECK (price_origin IN ('TEST_FIXTURE', 'VENDOR')),
  CONSTRAINT quote_snapshots_state_check CHECK (
    feed_state IN ('LIVE', 'DEGRADED', 'STALE', 'DISCONNECTED')
  )
);

CREATE TABLE bars (
  instrument_id uuid NOT NULL REFERENCES instruments (id) ON DELETE RESTRICT,
  timeframe text NOT NULL,
  bucket_start timestamptz NOT NULL,
  open numeric(24, 8) NOT NULL,
  high numeric(24, 8) NOT NULL,
  low numeric(24, 8) NOT NULL,
  close numeric(24, 8) NOT NULL,
  volume numeric(24, 8) NOT NULL,
  trade_count integer NOT NULL,
  price_origin text NOT NULL,
  PRIMARY KEY (instrument_id, timeframe, bucket_start),
  CONSTRAINT bars_timeframe_check CHECK (timeframe IN ('1m', '5m', '15m', '1h', '4h', '1d')),
  CONSTRAINT bars_ohlc_check CHECK (high >= low AND high >= open AND high >= close AND low <= open AND low <= close),
  CONSTRAINT bars_volume_check CHECK (volume >= 0 AND trade_count > 0),
  CONSTRAINT bars_origin_check CHECK (price_origin IN ('TEST_FIXTURE', 'VENDOR'))
);

CREATE TABLE feed_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL,
  status text NOT NULL,
  price_origin text NOT NULL,
  live_market_data boolean NOT NULL,
  detected_at timestamptz NOT NULL,
  detail text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feed_status_events_status_check CHECK (
    status IN ('LIVE', 'DEGRADED', 'STALE', 'DISCONNECTED')
  ),
  CONSTRAINT feed_status_events_origin_check CHECK (price_origin IN ('TEST_FIXTURE', 'VENDOR')),
  CONSTRAINT feed_status_events_claim_check CHECK (
    NOT (price_origin = 'TEST_FIXTURE' AND live_market_data)
    AND NOT (status <> 'LIVE' AND live_market_data)
  )
);

CREATE TRIGGER feed_status_events_append_only
  BEFORE UPDATE OR DELETE ON feed_status_events
  FOR EACH ROW
  EXECUTE FUNCTION k2_reject_mutation();

CREATE INDEX feed_status_events_detected_idx ON feed_status_events (detected_at DESC);
CREATE INDEX bars_lookup_idx ON bars (instrument_id, timeframe, bucket_start DESC);

INSERT INTO permissions (code, description) VALUES
  ('market_data.read', 'Read normalised market data with its origin label'),
  ('market_data.health', 'Read internal feed health'),
  ('market_data.manage', 'Register an instrument on an allowed venue');

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'market_data.read' FROM roles;

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'market_data.health' FROM roles WHERE is_staff;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('ADMIN', 'market_data.manage');
