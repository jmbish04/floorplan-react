CREATE TABLE IF NOT EXISTS prompt_sessions (
  id TEXT PRIMARY KEY,
  base_prompt TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  base_prompt_hash TEXT NOT NULL,
  history TEXT NOT NULL DEFAULT '[]',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS image_versions (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES image_versions(id),
  base_prompt TEXT,
  edit_prompt TEXT,
  model TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  image_url TEXT NOT NULL,
  metadata TEXT,
  chat_id TEXT REFERENCES prompt_sessions(id),
  aspect_ratio TEXT,
  diff_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_image_versions_parent ON image_versions(parent_id);
CREATE INDEX IF NOT EXISTS idx_image_versions_chat ON image_versions(chat_id);
