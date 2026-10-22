CREATE TABLE IF NOT EXISTS rootdata_credit_reservations (
  id bigserial PRIMARY KEY,
  credits integer NOT NULL CHECK (credits > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
