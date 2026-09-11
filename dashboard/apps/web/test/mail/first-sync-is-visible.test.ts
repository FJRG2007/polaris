/**
 * A mailbox that has just been connected, in the minutes before its mail is
 * here.
 *
 * The first pass reads the folder list and every folder's count in one command,
 * then walks the folders fetching envelopes - four hundred at most per folder,
 * one connection, minutes on a large account. Two things went wrong in that
 * window and both read as Polaris being broken.
 *
 * **The inbox was not first.** The folders were walked in alphabetical order of
 * their role, so on Gmail "all" - a copy of every message in the account - came
 * before "inbox". Somebody who had just connected their mailbox watched an empty
 * inbox while Polaris read All Mail.
 *
 * **And the empty inbox said it was empty.** Beside a rail saying it held four
 * thousand, which is the screen disagreeing with itself in the one moment its
 * reader has no way to tell which half is right.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("which folder is read first", () => {
    it("puts the inbox before everything, and All mail after everything", async () => {
        const sync = await readFile(`${SRC}lib/mailbox/sync.ts`, "utf8");
        const order = sync.slice(sync.indexOf("const SYNC_ORDER"));
        const list = order.slice(0, order.indexOf("];"));
        expect(list.indexOf('"inbox"')).toBeGreaterThan(0);
        // Every message in All mail is in another folder too, so it is the one
        // folder whose absence costs nothing for the longest.
        for (const role of ["sent", "drafts", "archive", "junk", "trash"]) {
            expect(list.indexOf(`"${role}"`), role).toBeGreaterThan(list.indexOf('"inbox"'));
            expect(list.indexOf(`"${role}"`), role).toBeLessThan(list.indexOf('"all"'));
        }
    });

    it("orders the pass by it rather than by the role's name", async () => {
        const sync = await readFile(`${SRC}lib/mailbox/sync.ts`, "utf8");
        expect(sync).toContain(
            "folders.sort((left, right) => syncRank(left.role) - syncRank(right.role));"
        );
        expect(sync).not.toContain('orderBy: { role: "asc" }');
    });

    it("puts a folder it does not know among the ones with no role", async () => {
        const sync = await readFile(`${SRC}lib/mailbox/sync.ts`, "utf8");
        expect(sync).toContain('return at === -1 ? SYNC_ORDER.indexOf("none") : at;');
    });
});

describe("what the list says while it waits", () => {
    it("reads the server's own count off the folder, which is right before the first envelope", async () => {
        const view = await readFile(`${SRC}app/(app)/mail/mail-view.tsx`, "utf8");
        expect(view).toContain("feeding.some((folder) => folder.total > 0)");
        expect(view).toContain("threads.length === 0");
    });

    it("draws the rows that are coming rather than an empty state", async () => {
        const view = await readFile(`${SRC}app/(app)/mail/mail-view.tsx`, "utf8");
        const branch = view.slice(view.indexOf(") : stillFetching ? ("));
        const rest = branch.slice(0, branch.indexOf("threads.every"));
        expect(rest).toContain("<ThreadRowsSkeleton />");
        expect(rest).toContain("Fetching this mailbox");
    });

    it("never says it over a search, a tab or a filter", async () => {
        // Those have every right to come back empty out of a folder that is
        // full, and saying "still fetching" over one would be an excuse.
        const view = await readFile(`${SRC}app/(app)/mail/mail-view.tsx`, "utf8");
        expect(view).toContain(
            'const narrowed = Boolean(page.query) || filter !== "" || category !== "";'
        );
        expect(view).toContain("!narrowed && threads.length === 0");
    });
});
