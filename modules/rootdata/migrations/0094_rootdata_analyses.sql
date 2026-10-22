CREATE TABLE IF NOT EXISTS rootdata_analyses (
  project_id bigint PRIMARY KEY REFERENCES rootdata_projects(id) ON DELETE CASCADE,
  inputs_hash text NOT NULL,
  output jsonb,
  model text,
  receipt_id bigint REFERENCES receipts(id),
  generated_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
