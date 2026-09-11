/**
 * When a conversation stops being unread, and how much of it does.
 *
 * Two bugs, one screen, both reported as "I open it and it does not go read".
 *
 * **It waited for the body.** The mark lived on the message rows inside the
 * reading pane, and there are no rows until the conversation has been fetched -
 * a round trip that opens with a database read and sometimes ends at somebody
 * else's IMAP server. Opening a message and going back before that landed, which
 * is most of what clearing a mailbox is, marked nothing at all.
 *
 * **It marked one message.** A conversation of four unread was handed to the
 * server as the message leading it, so the other three stayed unread and the row
 * stayed bold - the mark having plainly been pressed. Every mail client anybody
 * has used marks the conversation.
 *
 * Asserted against the source, in the shape of the two rules: the mark is fired
 * from the list off the row it already holds, and it says it means the whole
 * conversation. Running it would prove a mock was called.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { scopeOf } from "@/app/(app)/mail/mail-actions";

const SCREENS = fileURLToPath(new URL("../../src/app/(app)/mail/", import.meta.url));
const MAILBOX = fileURLToPath(new URL("../../src/lib/mailbox/", import.meta.url));

describe("what an action aimed at a row is aimed at", () => {
    it("means the conversation for read and unread", () => {
        for (const action of ["read", "unread"] as const) {
            expect(scopeOf(action), action).toBe("conversation");
        }
    });

    it("means the messages themselves for everything else", () => {
        // A conversation lives in several folders at once, so archiving "the
        // conversation" would be a promise about mail the view is not showing.
        for (const action of ["archive", "trash", "delete", "junk", "star", "important"] as const) {
            expect(scopeOf(action), action).toBe("message");
        }
    });
});

describe("marking it read on the way in", () => {
    it("fires from the list, off the row it already holds", async () => {
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        expect(view).toContain('if (preferences.markRead !== "open" || !openThread) return;');
        expect(view).toContain("messageIds: [row.leadMessageId]");
        expect(view).toContain('scope: "conversation"');
    });

    it("moves the row and the rail without waiting for the mail server", async () => {
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        const mark = view.slice(view.indexOf("const [readOnOpen, setReadOnOpen]"));
        const body = mark.slice(0, mark.indexOf("const act = useCallback"));
        expect(body).toContain("nudgeUnread(unreadNudges([row]))");
        expect(body).toContain("patch([row.id], { unreadCount: 0 })");
        // Nobody waits on the answer: a refusal leaves it unread, which is the
        // truth, and the next list brings the bold row back on its own.
        expect(body).toContain("void actOnAction({");
    });

    it("belongs to the conversation that was open, and to no other", async () => {
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        expect(view).toContain('useEffect(() => setReadOnOpen(""), [openThreadId]);');
        expect(view).toContain("if (readOnOpen === row.id || row.unreadCount === 0");
    });

    it("tells the pane, so opening never costs a second round trip", async () => {
        // The body the pane draws was fetched beside the mark and can still say
        // unread, and the pane marks anything unread it has open.
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        const thread = await readFile(`${SCREENS}thread-view.tsx`, "utf8");
        expect(view).toContain("readAlready={readOnOpen === openThread.id}");
        expect(thread).toContain("readAlready={readAlready}");
        expect(thread).toContain(
            "if (!open || message.seen || marked.current || readAlready) return;"
        );
    });

    it("leaves a message somebody expands by hand to the pane", async () => {
        // An older message opened inside a conversation is a message they have
        // read, and `delay` waits on purpose.
        const thread = await readFile(`${SCREENS}thread-view.tsx`, "utf8");
        expect(thread).toContain('if (markRead === "never") return;');
        expect(thread).toContain("setTimeout(mark, core.MAIL_MARK_READ_DELAY_MS)");
    });
});

describe("marking the whole conversation", () => {
    it("reads the rest of it from the server, narrowed by its owner", async () => {
        const access = await readFile(`${MAILBOX}access.ts`, "utf8");
        expect(access).toContain(
            "export function ownedThreadMessages(userId: string, threadIds: readonly string[])"
        );
        const owned = access.slice(access.indexOf("export function ownedThreadMessages"));
        expect(owned.slice(0, owned.indexOf("}\n"))).toContain(
            "where: { threadId: { in: [...threadIds] }, account: { userId } }"
        );
    });

    it("does it for a flag and never for a move", async () => {
        const messages = await readFile(`${MAILBOX}messages.ts`, "utf8");
        expect(messages).toContain(
            'options.scope === "conversation" && (action === "read" || action === "unread")'
        );
        // The expansion is inside the flag branch, which returns before anything
        // a move does is reached.
        const flag = messages.slice(messages.indexOf("const flag = FLAG_ACTIONS[action];"));
        expect(flag.slice(0, flag.indexOf("// What somebody just said"))).toContain(
            "ownedThreadMessages(userId, ["
        );
    });

    it("is what the screens ask for", async () => {
        for (const screen of ["mail-view.tsx", "thread-view.tsx"]) {
            const source = await readFile(`${SCREENS}${screen}`, "utf8");
            expect(source, screen).toContain("scopeOf(action)");
        }
    });
});
