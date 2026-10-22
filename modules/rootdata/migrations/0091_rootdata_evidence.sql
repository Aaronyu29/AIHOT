CREATE TABLE IF NOT EXISTS rootdata_evidence (
  project_id bigint NOT NULL REFERENCES rootdata_projects(id) ON DELETE CASCADE,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('funding', 'update')),
  publication_revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, article_id)
);
