/**
 * Server-only Admin-Gate.
 *
 * Kein Login/Accounts – nur ein gemeinsames Passwort (ADMIN_PASSWORD), das
 * ausschließlich serverseitig geprüft wird. Der Freischalt-Status liegt in
 * einer verschlüsselten Cookie-Session (SESSION_SECRET), damit ein Reload
 * die Admin-Ansicht offen lässt.
 *
 * Wichtig: Diese Datei darf nie im Browser-Bundle landen (Dateiname *.server.ts
 * wird von der Import-Protection blockiert).
 */
import { useSession } from "@tanstack/react-start/server";
import { createHash, timingSafeEqual } from "node:crypto";

type AdminSession = { unlocked?: boolean };

function sessionConfig() {
  return {
    password: process.env.SESSION_SECRET!,
    name: "admin-gate",
    maxAge: 60 * 60 * 24 * 7, // 7 Tage
    cookie: { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/" },
  };
}

export function getAdminSession() {
  return useSession<AdminSession>(sessionConfig());
}

/**
 * Timing-sicherer Vergleich. Beide Seiten werden zuerst gehasht, damit
 * timingSafeEqual gleich lange Buffer bekommt (und die Länge nichts verrät).
 */
export function passwordMatches(input: string, expected: string): boolean {
  const a = createHash("sha256").update(input, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Wirft, wenn die Session nicht freigeschaltet ist. Vor jeder Schreiboperation aufrufen. */
export async function requireAdmin(): Promise<void> {
  const session = await getAdminSession();
  if (!session.data.unlocked) {
    throw new Error("Nicht freigeschaltet – bitte im Admin-Bereich das Passwort eingeben.");
  }
}
