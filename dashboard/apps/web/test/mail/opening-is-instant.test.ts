/**
 * Opening a message, and how long it takes.
 *
 * Polaris keeps envelopes and fetches a body the first time somebody opens it -
 * which is the right storage model (a mailbox is forty megabytes of slide decks
 * nobody will read) and the wrong reading experience, because that first open is
 * a round trip to somebody else's IMAP server: a connection, a mailbox lock, the
 * body structure, then the parts. Next to a webmail that holds everything itself,
 * it felt slow, and it was.
 *
 * The fix is not a different storage model. It is that nobody clicks a row they
 * have not been looking at: the pointer rests, or the keyboard cursor lands, and
 * that is enough time to have gone and got it.
 *
 * Asserted against the source, because what matters is the shape - once per
 * message, on a rest rather than on every crossing, and never replacing a handler
 * the row was already given. Running it would prove a mock was called.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const MAIL = new URL("../../src/app/(app)/mail/", import.meta.url);

const list = await readFile(new URL("mail-view.tsx", MAIL), "utf8");
const actions = await readFile(new URL("actions.ts", MAIL), "utf8");

describe("fetching a body before it is asked for", () => {
    it("has an action that keeps the body and answers nothing", () => {
        // Nothing comes back on purpose: the body lands on the row it belongs to
        // and the open that follows finds it there. Returning it would be sending
        // a megabyte to a screen that has not asked for it.
        expect(actions).toContain("export async function warmMessageAction(messageId: string): Promise<void>");
        expect(actions).toContain("await messages.loadBody(userId, messageId);");
    });

    it("never surfaces a failure from something nobody asked for", () => {
        const warm = actions.slice(actions.indexOf("export async function warmMessageAction"));
        expect(warm.slice(0, warm.indexOf("}\n\n"))).toContain("catch {");
    });

    it("waits for the pointer to rest", () => {
        // Running down a list of fifty must ask for nothing.
        expect(list).toMatch(/const WARM_AFTER_MS = \d+;/);
        expect(list).toContain("setTimeout(() => {");
    });

    it("asks once per message and never again", () => {
        // The answer is kept on the row, so a second ask is a database read for
        // nothing.
        expect(list).toContain("warmed.current.has(messageId)");
        expect(list).toContain("warmed.current.add(next)");
    });

    it("runs one at a time, however fast the pointer moves", () => {
        // A body that is not held yet is a whole IMAP session, and the large
        // mail hosts answer a dozen at once by locking the account out of its
        // own mailbox. So a rest that lands while one is in the air waits in a
        // single slot rather than opening a second connection.
        expect(list).toContain("if (fetching.current) return;");
        expect(list).toContain("while (onScreen.current && wanted.current)");
        expect(list).toContain("await warmMessageAction(next)");
    });

    it("is reached by the pointer and by the keyboard", () => {
        // Somebody arrowing down a list is deciding what to open exactly as
        // somebody hovering is, and the wait afterwards is the same wait.
        expect(list).toContain("onPointerEnter={(event) => {");
        expect(list).toContain("if (onRow?.leadMessageId) warm(onRow.leadMessageId);");
    });

    it("adds to the handlers the row was given rather than replacing them", () => {
        // The row is a context-menu trigger and is handed handlers by it.
        // Overwriting one would cost the right-click menu to save a fetch.
        expect(list).toContain("rest.onPointerEnter?.(event);");
        expect(list).toContain("rest.onFocus?.(event);");
    });

    it("stops when the screen goes", () => {
        // A timer that fires after this list is gone, or a slot drained after
        // it, asks for a body nobody is waiting for.
        expect(list).toContain("if (warming.current) clearTimeout(warming.current);");
        expect(list).toContain("onScreen.current = false;");
    });
});
