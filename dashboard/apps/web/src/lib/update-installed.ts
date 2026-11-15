/**
 * Which update this deployment last installed: the build it ran before and the
 * one it runs now, so "What changed in this update" can still be read once the
 * restart has happened.
 *
 * Two rows in the settings table, both added on demand, so an install that
 * predates them simply has none and the screen says the range is not known:
 *
 * - `updates.installFrom` - the build that was running when an install was
 *   started (`<sha> <iso>`). Written by `startUpdate`, the one path every
 *   install takes, button or schedule.
 * - `updates.lastInstalled` - the settled range (`<from> <to> <iso>`), written
 *   by the first container of the new build to look. Kept until the next
 *   install lands, so a later install that fails does not lose it.
 *
 * Ranges never overlap the update on offer: the installed one ends at the
 * running build, which is exactly where the available one starts.
 */

import { getSetting, setSetting } from "@/lib/setting-store";

const FROM_KEY = "updates.installFrom";
const LAST_KEY = "updates.lastInstalled";
const SHA = /^[0-9a-f]{7,40}$/i;

/** The range the running build was installed over; `from` null when unknown. */
export interface InstalledRange {
    readonly from: string | null;
    readonly to: string | null;
}

function short(sha: string): string {
    return sha.slice(0, 7);
}

function same(a: string, b: string): boolean {
    return short(a).toLowerCase() === short(b).toLowerCase();
}

function stamp(raw: string | null): string | null {
    const sha = raw?.split(" ")[0]?.trim() ?? "";
    return SHA.test(sha) ? sha : null;
}

/**
 * Note that an install is starting from `running`. The range the running build
 * itself was installed over is settled first, so this write never erases it.
 */
export async function recordInstallFrom(running: string, now = new Date()): Promise<void> {
    const sha = running.trim();
    if (!SHA.test(sha)) return;
    await settleInstalled(sha);
    await setSetting(FROM_KEY, `${sha} ${now.toISOString()}`);
}

/**
 * Turn a recorded start into the range the running build was installed over,
 * once that build is the one serving. `previous` is a second witness - the
 * build the last kept update check was made by - used only when no start was
 * recorded, which is every install made by a build older than this code.
 */
export async function settleInstalled(
    running: string | null | undefined,
    previous: string | null = null,
    now = new Date()
): Promise<void> {
    const sha = (running ?? "").trim();
    if (!SHA.test(sha)) return;
    const last = await getSetting(LAST_KEY);
    const settledTo = last?.split(" ")[1] ?? "";
    if (settledTo && SHA.test(settledTo) && same(settledTo, sha)) return;
    const recorded = stamp(await getSetting(FROM_KEY));
    const witness = previous && SHA.test(previous.trim()) ? previous.trim() : null;
    const from = recorded && !same(recorded, sha) ? recorded : witness && !same(witness, sha) ? witness : null;
    if (!from) return;
    await setSetting(LAST_KEY, `${from} ${sha} ${now.toISOString()}`);
    if (recorded) await setSetting(FROM_KEY, null);
}

/** The range the running build was installed over, as far as it is known. */
export async function installedRange(running: string | null): Promise<InstalledRange> {
    const sha = running?.trim() ?? "";
    if (!SHA.test(sha)) return { from: null, to: null };
    await settleInstalled(sha);
    const [from, to] = (await getSetting(LAST_KEY))?.split(" ") ?? [];
    if (!from || !to || !SHA.test(from) || !same(to, sha)) return { from: null, to: short(sha) };
    return { from: short(from), to: short(sha) };
}
