-- Authentication state is independent of dataset generations and survives publication cleanup.
CREATE TABLE IF NOT EXISTS byou_session_revocations (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS byou_session_revocations_expiry ON byou_session_revocations (expires_at);
CREATE TABLE IF NOT EXISTS byou_login_limits (
  key_hash text PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts >= 0),
  reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS byou_login_limits_expiry ON byou_login_limits (reset_at);
