/**
 * Apps an account keeps behind its PIN: which apps may be locked, which app a
 * path belongs to, and whether this session's unlock of it is still fresh.
 *
 * Pure, so the server guard and the menu read one answer. The account's own
 * screens and Settings are never lockable: they are where the PIN itself is
 * set and cleared, and locking them could leave somebody with no way back.
 *
 * An unlock lasts for the browser session and relocks after 15 minutes without
 * activity in that app - long enough not to be asked again while working in
 * it, short enough that a screen left open does not stay open to the next
 * person at the desk. Same reasoning as the dashboard's own idle lock, scoped
 * to one app.
 */

import { z } from "zod";
import { appOwningPath } from "@/lib/apps";

/** Idle time after which an unlocked app asks for the PIN again. */
export const APP_RELOCK_IDLE_MS = 15 * 60 * 1000;

/** How often an unlocked app's activity is written back, at most. */
export const APP_UNLOCK_TOUCH_MS = 60 * 1000;

/** Where a locked app sends its reader. */
export const APP_LOCK_PATH = "/app-lock";

export const appIdSchema = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/);

export const setAppLockSchema = z.object({ appId: appIdSchema, locked: z.boolean() });

export const unlockAppSchema = z.object({
    appId: appIdSchema,
    pin: z.string().regex(/^\d{4,6}$/)
});

/** Whether an app may be put behind the PIN: never the account or Settings. */
export function lockableApp(appId: string): boolean {
    return appId !== "account" && appId !== "admin" && !appId.startsWith("admin-");
}

/** The locked app a path belongs to, or null when it is open. */
export function lockedAppForPath(pathname: string, locked: readonly string[]): string | null {
    if (locked.length === 0) return null;
    const app = appOwningPath(pathname);
    if (!app || !lockableApp(app.id) || !locked.includes(app.id)) return null;
    return app.id;
}

/** The unlocks a session holds, read total: anything malformed is no unlock. */
export function readUnlocks(value: unknown): Record<string, number> {
    const parsed = z.record(z.string(), z.number().finite()).safeParse(value);
    return parsed.success ? parsed.data : {};
}

/** Whether this session's unlock of an app is still within the idle window. */
export function unlockFresh(unlocks: Record<string, number>, appId: string, now: number): boolean {
    const at = unlocks[appId];
    return at !== undefined && now - at >= 0 && now - at < APP_RELOCK_IDLE_MS;
}

/** A same-origin path to return to after unlocking, or the app's own root. */
export function safeReturnPath(next: unknown, fallback: string): string {
    if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return fallback;
    if (next.includes("\\") || /[\u0000-\u001f]/.test(next)) return fallback;
    return next.slice(0, 2048);
}

/** The lock screen's address for a locked app opened at `pathname`. */
export function appLockHref(appId: string, pathname: string): string {
    const query = new URLSearchParams({ app: appId, next: pathname });
    return `${APP_LOCK_PATH}?${query.toString()}`;
}
