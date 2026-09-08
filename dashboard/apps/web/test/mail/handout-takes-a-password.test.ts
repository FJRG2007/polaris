/**
 * Why an organization hands a mailbox out with a password.
 *
 * The dialog is shared with somebody connecting their own mailbox, and that one
 * can authorize a Google or Microsoft account instead of storing a password. On
 * the organization's screen it could not: the mailbox is created against its
 * holder, and the authorization offered belonged to the manager filling the form
 * in - so every attempt came back "That authorized account is not linked here
 * any more", about an account that was linked, to somebody who could do nothing
 * about it.
 *
 * So that path is not drawn there at all, and the dialog says why rather than
 * silently asking for a password.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("handing out a mailbox", () => {
    it("offers no authorized account, and none of somebody else's", async () => {
        const view = await readFile(
            `${SRC}app/(app)/account/organizations/[slug]/mailboxes/mailboxes-view.tsx`,
            "utf8"
        );
        expect(view).toContain("allowOauth={false}");
        expect(view).toContain("links={[]}");
    });

    it("says whose authorization it would have to be", async () => {
        const dialog = await readFile(`${SRC}app/(app)/mail/connect-dialog.tsx`, "utf8");
        expect(dialog).toContain("discovery.oauth && !allowOauth");
        expect(dialog).toContain("only its holder can authorize that");
    });

    it("redraws the register when one is handed out", async () => {
        const view = await readFile(
            `${SRC}app/(app)/account/organizations/[slug]/mailboxes/mailboxes-view.tsx`,
            "utf8"
        );
        // Seeded once and never again is a mailbox that was handed out and did
        // not appear on the screen that handed it out.
        expect(view).toContain("useEffect(() => setRows(mailboxes), [mailboxes]);");
    });
});
