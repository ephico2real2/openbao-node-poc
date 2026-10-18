export const NOTES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (
    id         bigserial PRIMARY KEY,
    body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 280),
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
