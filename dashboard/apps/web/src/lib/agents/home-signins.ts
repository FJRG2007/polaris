/**
 * Which agents a person has connected by signing in on their sessions' machine.
 *
 * A login of that kind lives in the tool's own files in the person's home, so
 * nothing about it was stored here, and the connections table had to ask every
 * agent in the catalogue whether it was signed in - a container per check - and
 * drew a row for each one, signed in or not. This is the list of the ones the
 * person actually connected: written when a sign-in finishes and when a
 * sign-out does, and when a check finds a login signed in from elsewhere.
 *
 * Null means it was never written, which is an account from before this list
 * existed: its first status read checks everything once and writes the answer.
 */

import { z } from "zod";
import { getSetting, setSetting } from "@/lib/setting-store";

const keyOf = (userId: string) => `agents.home-signins.${userId}`;
/** Every agent in the catalogue at most; anything longer was not written here. */
const STORED = z.array(z.string().max(64)).max(200);

export async function homeSigninsOf(userId: string): Promise<Set<string> | null> {
    const raw = await getSetting(keyOf(userId));
    if (raw === null) return null;
    try {
        const parsed = STORED.safeParse(JSON.parse(raw));
        return new Set(parsed.success ? parsed.data : []);
    } catch {
        return new Set();
    }
}

/** Write the whole list, as the first read of an older account does. */
export async function setHomeSignins(userId: string, envs: Iterable<string>): Promise<void> {
    await setSetting(keyOf(userId), JSON.stringify([...new Set(envs)].sort()));
}

/** Add or drop one agent. Writes only when that changes the list. */
export async function markHomeSignin(userId: string, env: string, signedIn: boolean): Promise<void> {
    const current = (await homeSigninsOf(userId)) ?? new Set<string>();
    if (current.has(env) === signedIn) return;
    if (signedIn) current.add(env);
    else current.delete(env);
    await setHomeSignins(userId, current);
}
