/**
 * Einfaches IP-basiertes Rate-Limiting (fixed window) auf Datenbank-Basis.
 *
 * Ablauf:
 *   1. IP der Anfrage bestimmen (X-Forwarded-For beachten).
 *   2. IP + Salt (SESSION_SECRET) mit SHA-256 hashen – wir speichern niemals
 *      die Klartext-IP.
 *   3. Zähler atomar in der DB-Funktion `hit_rate_limit` hochzählen.
 *      Diese liefert zurück, ob die Anfrage noch erlaubt ist und wie lange
 *      das aktuelle Zeitfenster noch läuft.
 *
 * Bewusst simpel gehalten: feste Zeitfenster, kein Token-Bucket.
 */
import { getRequestIP, getRequestHeader } from "@tanstack/react-start/server";

export type RateLimitResult = {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
};

async function hashClient(ip: string): Promise<string> {
  const salt = process.env.SESSION_SECRET ?? "ask-my-portfolio";
  const bytes = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Client-Kennung: echte IP, sonst Proxy-Header, sonst "unknown". */
function clientIp(): string {
  return (
    getRequestIP({ xForwardedFor: true }) ??
    getRequestHeader("cf-connecting-ip") ??
    getRequestHeader("x-real-ip") ??
    "unknown"
  );
}

/**
 * Zählt eine Anfrage für `bucket` und meldet, ob sie durchgelassen wird.
 * Bei DB-Fehlern wird die Anfrage bewusst erlaubt (fail-open), damit ein
 * Infrastrukturproblem die App nicht komplett blockiert.
 */
export async function checkRateLimit(
  bucket: string,
  { max, windowSeconds }: { max: number; windowSeconds: number },
): Promise<RateLimitResult> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const hash = await hashClient(clientIp());

    const { data, error } = await supabaseAdmin.rpc("hit_rate_limit", {
      _bucket: bucket,
      _client_hash: hash,
      _window_seconds: windowSeconds,
      _max_requests: max,
    });
    if (error) throw new Error(error.message);

    const row = Array.isArray(data) ? data[0] : data;
    return {
      allowed: row?.allowed ?? true,
      count: row?.current_count ?? 0,
      limit: max,
      retryAfterSeconds: row?.retry_after_seconds ?? windowSeconds,
    };
  } catch (err) {
    console.error("[rate-limit] Prüfung fehlgeschlagen – Anfrage wird durchgelassen", err);
    return { allowed: true, count: 0, limit: max, retryAfterSeconds: 0 };
  }
}
