/**
 * The web app's side of long-lived server shells. The sessions themselves live
 * in the terminal sidecar (`terminal-sessions.mjs`), the only process that holds
 * the SSH channels; this reaches it over loopback with the shared internal key.
 * The user id always comes from the caller's session here, never from the
 * browser, and the sidecar filters every answer by it.
 */

import { z } from "zod";

/** One session as the terminal screen lists it. */
export const terminalSessionSchema = z.object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    number: z.number().int().positive(),
    mode: z.enum(["ssh", "ssh-root"]),
    createdAt: z.string(),
    lastActiveAt: z.string(),
    attached: z.boolean()
});
export type TerminalSession = z.infer<typeof terminalSessionSchema>;

const listSchema = z.object({
    sessions: z.array(terminalSessionSchema),
    /** Sessions this user holds on every server, against the cap. */
    used: z.number().int().nonnegative(),
    cap: z.number().int().positive(),
    idleMinutes: z.number().int().positive()
});
export type TerminalSessionList = z.infer<typeof listSchema>;

/** The sidecar could not be reached or answered something unexpected. */
export class SidecarUnavailable extends Error {}

function sidecarUrl(query = ""): string {
    const port = Number(process.env.POLARIS_WS_PORT || 3001);
    return `http://127.0.0.1:${port}/internal/terminal-sessions${query}`;
}

function headers(): Record<string, string> {
    return {
        "content-type": "application/json",
        "x-internal-key": process.env.POLARIS_AUTH_SECRET ?? ""
    };
}

export async function listTerminalSessions(
    userId: string,
    hostId: string
): Promise<TerminalSessionList> {
    const query = `?${new URLSearchParams({ userId, hostId })}`;
    const res = await fetch(sidecarUrl(query), {
        headers: headers(),
        cache: "no-store",
        signal: AbortSignal.timeout(5_000)
    }).catch(() => null);
    if (!res?.ok) throw new SidecarUnavailable();
    const parsed = listSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new SidecarUnavailable();
    return parsed.data;
}

/** Rename or close one of this user's sessions. False when it is not theirs or
 *  has already ended - the two are not told apart. */
export async function changeTerminalSession(
    userId: string,
    change:
        | { action: "rename"; hostId: string; id: string; name: string }
        | { action: "close"; hostId: string; id: string }
): Promise<boolean> {
    const res = await fetch(sidecarUrl(), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ userId, ...change }),
        signal: AbortSignal.timeout(5_000)
    }).catch(() => null);
    if (!res) throw new SidecarUnavailable();
    if (res.status === 404) return false;
    if (!res.ok) throw new SidecarUnavailable();
    return true;
}
