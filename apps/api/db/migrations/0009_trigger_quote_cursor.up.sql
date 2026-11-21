-- One cursor per instrument and quote source. A trigger runs only when the
-- update id is newer, and the cursor moves in the same transaction as the
-- trigger state change. Does not change 0001–0008.

CREATE TABLE trigger_quote_cursor (
  instrument_id uuid NOT NULL REFERENCES instruments (id) ON DELETE RESTRICT,
  source text NOT NULL,
  last_update_id numeric(38, 0) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, source),
  CONSTRAINT trigger_quote_cursor_update_check CHECK (last_update_id >= 0)
);
