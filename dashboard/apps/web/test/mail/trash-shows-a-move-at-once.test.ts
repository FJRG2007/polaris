/**
 * A message put in the trash shows in the trash on that same read.
 *
 * Seen on an IONOS mailbox: a trashed message's row often appeared only when the
 * next one was trashed. The read of the destination right after the move ran on
 * a fresh session the server had not yet shown the message, so it stored nothing.
 * Reproduced with a fake destination that answers stale twice.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { LANDING_TRIES, readUntilLanded } from "@/lib/mailbox/settle-landing";

/** A trash whose sessions see a move only after `lag` reads. */
function laggingTrash(lag: number, landed: number[]) {
    let reads = 0;
    return vi.fn(async () => {
        reads += 1;
        return new Set(reads > lag ? landed : []);
    });
}

describe("reading the trash after a move", () => {
    it("reads again until the moved message is stored", async () => {
        const read = laggingTrash(2, [13140]);
        const wait = vi.fn(async () => undefined);
        expect(await readUntilLanded([13140], read, wait)).toBe(true);
        expect(read).toHaveBeenCalledTimes(3);
        expect(wait).toHaveBeenCalledTimes(2);
    });

    it("reads once when the first read already has it", async () => {
        const read = laggingTrash(0, [5, 6]);
        expect(await readUntilLanded([5, 6], read, async () => undefined)).toBe(true);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it("gives up after a few reads, leaving it to the next pass", async () => {
        const read = laggingTrash(99, [7]);
        expect(await readUntilLanded([7], read, async () => undefined)).toBe(false);
        expect(read).toHaveBeenCalledTimes(LANDING_TRIES);
    });
});

describe("the move hands its uids to that read", () => {
    const read = (path: string) =>
        readFile(fileURLToPath(new URL(`../../src/lib/mailbox/${path}`, import.meta.url)), "utf8");

    it("from COPYUID to catchUpFolder", async () => {
        const messages = await read("messages.ts");
        expect(messages).toContain("[...moved.uidMap.values()]");
        expect(messages).toContain("catchUpFolder(client, account.id, folderId, arrived)");
        const sync = await read("sync.ts");
        expect(sync).toContain("await readUntilLanded(arrived, async (attempt) => {");
        expect(sync).toContain("if (attempt > 0) await client.noop();");
    });
});
