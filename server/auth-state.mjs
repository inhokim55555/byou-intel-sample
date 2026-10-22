import { createHash } from "node:crypto";

const hash = value => createHash("sha256").update(String(value)).digest("hex");
const unavailable = () => Object.assign(new Error("Sign-in is temporarily unavailable. Please try again."), { status:503, code:"AUTH_STATE_UNAVAILABLE" });

// The memory adapter is for database-free local/test runs only. A configured but
// unreachable database must never silently fall back to process-local state.
export function createAuthState({ connect, production = false, now = Date.now, windowMs = 900000, maxAttempts = 8 } = {}) {
  const revocations = new Map();
  const attempts = new Map();
  async function database(work) {
    let client;
    try { client = await connect(); return await work(client); }
    catch (error) {
      const code = /^[A-Z0-9_]{1,48}$/.test(String(error?.code || "")) ? error.code : "DATABASE_ERROR";
      console.error("[BYOU Intel] Authentication storage failed:", code);
      throw unavailable();
    }
    finally { client?.release(); }
  }
  function requireLocal() { if (production) throw unavailable(); }
  return {
    mode:connect ? "postgresql" : production ? "unavailable" : "local-memory",
    async isRevoked(token) {
      const key = hash(token);
      if (connect) return database(async client => !!(await client.query("SELECT 1 FROM byou_session_revocations WHERE token_hash=$1 AND expires_at > clock_timestamp()", [key])).rowCount);
      requireLocal();
      return (revocations.get(key) || 0) > now();
    },
    async revoke(token, expiresAt) {
      const key = hash(token);
      if (connect) return database(client => client.query("INSERT INTO byou_session_revocations (token_hash, expires_at) VALUES ($1, $2) ON CONFLICT (token_hash) DO UPDATE SET expires_at=GREATEST(byou_session_revocations.expires_at, EXCLUDED.expires_at)", [key, new Date(expiresAt)]));
      requireLocal();
      revocations.set(key, expiresAt);
    },
    // Serialize the check and update in PostgreSQL so replicas and concurrent
    // requests cannot each spend the same remaining attempt. No raw IP/cookie is stored.
    async attempt(key, valid) {
      key = hash(key);
      if (connect) return database(async client => {
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL lock_timeout = '5s'");
          await client.query("SET LOCAL statement_timeout = '5s'");
          await client.query("INSERT INTO byou_login_limits (key_hash, attempts, reset_at) VALUES ($1, 0, clock_timestamp() + $2 * interval '1 millisecond') ON CONFLICT DO NOTHING", [key, windowMs]);
          const { rows:[row] } = await client.query("SELECT attempts, reset_at > clock_timestamp() AS active FROM byou_login_limits WHERE key_hash=$1 FOR UPDATE", [key]);
          const count = row.active ? row.attempts : 0;
          const limited = count >= maxAttempts;
          if (!limited) {
            // Keep the row (including on success) until its window expires, so a
            // concurrent UPSERT/row-lock cannot lose the row underneath itself.
            await client.query("UPDATE byou_login_limits SET attempts=$2, reset_at=CASE WHEN reset_at <= clock_timestamp() THEN clock_timestamp() + $3 * interval '1 millisecond' ELSE reset_at END WHERE key_hash=$1", [key, valid ? 0 : count + 1, windowMs]);
          }
          await client.query("COMMIT");
          return { limited, accepted:!limited && valid };
        } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      });
      requireLocal();
      let row = attempts.get(key);
      if (!row || row.resetAt <= now()) row = { count:0, resetAt:now() + windowMs };
      const limited = row.count >= maxAttempts;
      if (!limited) row.count = valid ? 0 : row.count + 1;
      attempts.set(key, row);
      return { limited, accepted:!limited && valid };
    },
    async sweep() {
      if (connect) return database(async client => {
        await client.query("DELETE FROM byou_session_revocations WHERE expires_at <= clock_timestamp()");
        // Allow a grace period so pruning cannot race an expired-row login.
        await client.query("DELETE FROM byou_login_limits WHERE reset_at < clock_timestamp() - interval '1 day'");
      });
      requireLocal();
      for (const [key, expiry] of revocations) if (expiry <= now()) revocations.delete(key);
      for (const [key, row] of attempts) if (row.resetAt <= now()) attempts.delete(key);
    },
  };
}
