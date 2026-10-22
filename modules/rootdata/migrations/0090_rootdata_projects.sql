CREATE TABLE IF NOT EXISTS rootdata_projects (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  name_key text NOT NULL UNIQUE,
  rootdata_id bigint UNIQUE,
  profile jsonb,
  profile_updated_at timestamptz,
  next_refresh_at timestamptz NOT NULL DEFAULT now(),
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  tracking_status text NOT NULL DEFAULT 'watching' CHECK (tracking_status IN ('watching', 'paused')),
  public_reason text NOT NULL DEFAULT '',
  last_error text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
