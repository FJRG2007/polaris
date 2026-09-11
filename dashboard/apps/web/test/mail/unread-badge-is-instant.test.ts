/**
 * The number on the app switcher, and how long it takes to agree with the
 * screen under it.
 *
 * It is the server's count, asked for when the live channel says a mailbox
 * moved. That is right for mail arriving and wrong for mail being read: the
 * folder in Mail's own rail moves the instant somebody opens a message, because
 * the screen lays what it has just done over the server's figures, while the
 * badge outside Mail stood at the old number until the mail server had been
 * told, had answered, and had announced it - seconds, next to a message plainly
 * read.
 *
 * So the same overlay, in the same shape, one level up: a count laid over the
 * server's, dropped the moment the server's own figure moves.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SCREENS = fileURLToPath(new URL("../../src/app/(app)/mail/", import.meta.url));
const COMPONENTS = fileURLToPath(new URL("../../src/components/", import.meta.url));

describe("the badge outside Mail", () => {
    it("can be moved by the screen that knows first", async () => {
        const badge = await readFile(`${COMPONENTS}mail-unread.tsx`, "utf8");
        expect(badge).toContain("export function useNudgeMailUnread(): (by: number) => void");
        expect(badge).toContain("const [drift, setDrift] = useState(0);");
    });

    it("lets the overlay go the moment the server's own count moves", async () => {
        // Held any longer and it is counted twice: the recount that follows an
        // action already has what the overlay was standing in for.
        const badge = await readFile(`${COMPONENTS}mail-unread.tsx`, "utf8");
        const drop = badge.slice(badge.indexOf("const nudge = useCallback"));
        expect(drop.slice(0, drop.indexOf("const shown ="))).toContain(
            "setDrift((held) => (held === 0 ? held : 0));"
        );
        expect(badge).toContain("Math.max(0, unread.messages + drift)");
    });

    it("never says a mailbox is waiting with nothing in it", async () => {
        const badge = await readFile(`${COMPONENTS}mail-unread.tsx`, "utf8");
        expect(badge).toContain("mailboxes: messages === 0 ? 0 : unread.mailboxes");
    });

    it("moves on the same deltas the rail does, and only for an inbox", async () => {
        // The badge counts inboxes across every shelf, which is the question the
        // mailbox badges in the rail answer - so mail read in Archive moves the
        // folder's number and neither of those.
        const shell = await readFile(`${SCREENS}mail-shell.tsx`, "utf8");
        expect(shell).toContain("const nudgeBadge = useNudgeMailUnread();");
        const nudge = shell.slice(shell.indexOf("const nudgeUnread = useCallback"));
        const body = nudge.slice(0, nudge.indexOf("setDrift((held) => {"));
        expect(body).toContain("nudgeBadge(");
        expect(body).toContain('folder?.role === "inbox" ? sum + entry.by : sum');
    });
});
