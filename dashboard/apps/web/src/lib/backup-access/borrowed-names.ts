/**
 * Names given a record on the relay after a flip began.
 *
 * The flip's originals were saved when it started, and they can only hold what
 * existed then, in the base zone. A custom domain or a new zone name written while
 * the relay holds the records is neither, so it is kept here and follows the records
 * when they move. Empty again once the records are back on the line.
 */

import { z } from "zod";
import { backupRecordsTarget } from "@/lib/backup-access";
import { getSetting, setSetting } from "@/lib/setting-store";

const BORROWED_KEY = "backupAccess.borrowed";
/** A day of passes: long enough for an outage, short of keeping a removed zone forever. */
const MOST_TRIES = 1440;

const borrowedSchema = z.array(
    z.object({
        zoneId: z.string(),
        name: z.string(),
        address: z.string(),
        tries: z.number().int().nonnegative().default(0)
    })
);
export type BorrowedName = z.infer<typeof borrowedSchema>[number];

function parseBorrowed(raw: string | null): BorrowedName[] {
    if (!raw) return [];
    try {
        return borrowedSchema.safeParse(JSON.parse(raw)).data ?? [];
    } catch {
        return [];
    }
}

export async function readBorrowed(): Promise<BorrowedName[]> {
    return parseBorrowed(await getSetting(BORROWED_KEY));
}

let writes: Promise<unknown> = Promise.resolve();

/** One read-change-write at a time: several names can be added at once. */
function changeBorrowed(change: (names: BorrowedName[]) => BorrowedName[]): Promise<void> {
    const run = writes.then(async () => {
        const next = change(await readBorrowed());
        await setSetting(BORROWED_KEY, next.length > 0 ? JSON.stringify(next) : null);
    });
    writes = run.catch(() => undefined);
    return run;
}

/** Note a name about to be written with `address`, when that address is the relay
 *  holding the records. Called before the write, as the originals are. */
export async function borrowRelayName(
    zoneId: string,
    name: string,
    address: string
): Promise<void> {
    const target = await backupRecordsTarget();
    if (target?.kind !== "relay" || target.address !== address) return;
    await changeBorrowed((names) => [
        ...names.filter((entry) => entry.name !== name),
        { zoneId, name, address, tries: 0 }
    ]);
}

/** Record that these names moved: to `address`, or off the relay for good when null. */
export function settleBorrowed(
    moved: readonly BorrowedName[],
    address: string | null
): Promise<void> {
    const settled = new Set(moved.map((entry) => entry.name));
    return changeBorrowed((names) =>
        address
            ? names.map((entry) =>
                  settled.has(entry.name) && entry.address !== address
                      ? { ...entry, address, tries: 0 }
                      : entry
              )
            : names.filter((entry) => !settled.has(entry.name))
    );
}

/** Count a pass that could not move these names, and give up on the ones out of tries.
 *  Answers those, for the caller to tell an administrator: their records stay where
 *  they are, and nothing here looks at them again. */
export async function missBorrowed(missed: readonly BorrowedName[]): Promise<string[]> {
    const names = new Set(missed.map((entry) => entry.name));
    let abandoned: string[] = [];
    await changeBorrowed((all) => {
        const counted = all.map((entry) =>
            names.has(entry.name) ? { ...entry, tries: entry.tries + 1 } : entry
        );
        abandoned = counted.filter((entry) => entry.tries >= MOST_TRIES).map((entry) => entry.name);
        return counted.filter((entry) => entry.tries < MOST_TRIES);
    });
    return abandoned;
}
