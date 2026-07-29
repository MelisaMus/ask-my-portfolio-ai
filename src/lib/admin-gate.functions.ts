/**
 * Server-Funktionen für das Admin-Passwort-Gate.
 * Das Passwort selbst verlässt nie den Server; der Client bekommt nur ok: true/false.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const getAdminStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { getAdminSession } = await import("./admin-gate.server");
  const session = await getAdminSession();
  return {
    unlocked: session.data.unlocked === true,
    configured: Boolean(process.env.ADMIN_PASSWORD),
  };
});

export const unlockAdmin = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ password: z.string().min(1) }).parse(data))
  .handler(async ({ data }) => {
    const { getAdminSession, passwordMatches } = await import("./admin-gate.server");
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) throw new Error("ADMIN_PASSWORD ist nicht gesetzt.");
    if (!passwordMatches(data.password, expected)) return { ok: false as const };
    const session = await getAdminSession();
    await session.update({ unlocked: true });
    return { ok: true as const };
  });

export const lockAdmin = createServerFn({ method: "POST" }).handler(async () => {
  const { getAdminSession } = await import("./admin-gate.server");
  const session = await getAdminSession();
  await session.clear();
  return { ok: true as const };
});
