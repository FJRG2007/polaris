/**
 * Connecting a mailbox with a provider, and the account that comes back.
 *
 * Somebody types the address of the mailbox they want. The consent screen then
 * opens on whichever account that browser is already signed into, they press
 * Continue, and Polaris held a token for one mailbox and a form that said
 * another. What followed was a mailbox that could not log in, under a sentence
 * from an IMAP server that named neither account - or, on the dialog's side, a
 * list of every authorized account with the first one picked, which is the same
 * mistake made for them.
 *
 * Three things close it, and each is asserted here because any one alone leaves
 * a way through:
 *
 * - the trip carries the address it is FOR, so the provider opens on that
 *   account;
 * - the callback refuses to link any other, and links nothing at all;
 * - the dialog only ever offers an authorization whose address is this mailbox.
 *
 * And the fourth thing, which is not about correctness: what somebody typed is
 * still there when they come back, and the mailbox finishes adding itself.
 * Pressing Authorize was one step of adding a mailbox, never a thing anybody
 * wanted done on its own.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("the trip out", () => {
    it("carries the mailbox it is for, validated rather than as typed", async () => {
        const flow = await readFile(`${SRC}lib/connections/link-flow.ts`, "utf8");
        expect(flow).toContain('core.mailAddress.safeParse(url.searchParams.get("address") ?? "")');
        // In the cookie, not in the URL: between the two halves the URL is the
        // one thing somebody can edit.
        expect(flow).toContain("...(about?.wanted ? { wanted: about.wanted } : {})");
    });

    it("opens the provider on that account", async () => {
        const flow = await readFile(`${SRC}lib/connections/link-flow.ts`, "utf8");
        const google = await readFile(`${SRC}lib/google-calendar/service.ts`, "utf8");
        const microsoft = await readFile(`${SRC}lib/connections/microsoft.ts`, "utf8");
        expect(flow).toContain("about?.wanted");
        for (const [name, source] of [
            ["google", google],
            ["microsoft", microsoft]
        ] as const) {
            expect(source, name).toContain('url.searchParams.set("login_hint", loginHint)');
        }
    });

    it("is the dialog that names it, for both the first authorization and a reconnect", async () => {
        const dialog = await readFile(`${SRC}app/(app)/mail/connect-dialog.tsx`, "utf8");
        expect(dialog).toContain("scope=mail&address=${encodeURIComponent(");
        // A reconnect comes back to the mailbox it was for rather than to a list.
        expect(dialog).toContain("`&edit=${encodeURIComponent(editing.id)}`");
        expect(dialog.match(/href=\{authorizeHref\}/g)?.length).toBe(2);
    });
});

describe("the account that comes back", () => {
    it("has to be the one it was started for, and nothing is linked when it is not", async () => {
        const flow = await readFile(`${SRC}lib/connections/link-flow.ts`, "utf8");
        expect(flow).toContain('if (wanted && !sameAddress(authorized.email ?? "", wanted)) {');
        const refusal = flow.slice(flow.indexOf("if (wanted && !sameAddress"));
        // Refused BEFORE the link is written: an account somebody never meant to
        // connect must not end up on their profile either.
        expect(refusal.indexOf('"wrong_account"')).toBeLessThan(refusal.indexOf("saveConnection"));
    });

    it("is said on the screen it came back to", async () => {
        const view = await readFile(
            `${SRC}app/(app)/mail/settings/accounts/accounts-view.tsx`,
            "utf8"
        );
        expect(view).toContain('outcome === "wrong_account"');
        expect(view).toContain("Nothing was connected");
    });
});

describe("what the dialog will use", () => {
    it("offers only an authorization whose address is this mailbox", async () => {
        const dialog = await readFile(`${SRC}app/(app)/mail/connect-dialog.tsx`, "utf8");
        expect(dialog).toContain(
            'forAddress !== "" && link.address !== "" && sameAddress(link.address, forAddress)'
        );
    });

    it("knows each authorization's address", async () => {
        // Read off the label, because that is where these two providers put it.
        const options = await readFile(`${SRC}lib/mailbox/connect-options.ts`, "utf8");
        expect(options).toContain("address: addressOf(link.label)");
        expect(options).toContain('return trimmed.includes("@") ? trimmed : "";');
    });

    it("says so when the account authorized was a different one", async () => {
        const dialog = await readFile(`${SRC}app/(app)/mail/connect-dialog.tsx`, "utf8");
        expect(dialog).toContain("const otherAccount = usable.length === 0 && authorized.length > 0;");
        expect(dialog).toContain("account you authorized is not");
    });
});

describe("coming back", () => {
    it("finds the address still there", async () => {
        const dialog = await readFile(`${SRC}app/(app)/mail/connect-dialog.tsx`, "utf8");
        // Kept for this tab only, and only for as long as signing in takes.
        expect(dialog).toContain('const RESUME_KEY = "polaris.mail.connecting";');
        expect(dialog).toContain("window.sessionStorage.setItem(RESUME_KEY");
        expect(dialog).toContain("onClick={() => keepResume(forAddress)}");
    });

    it("opens the form again rather than landing on a closed one", async () => {
        const flow = await readFile(`${SRC}lib/connections/link-flow.ts`, "utf8");
        expect(flow).toContain('return held.edit ? { edit: held.edit } : { connect: "1" };');
    });

    it("finishes adding the mailbox once everything it needs is there", async () => {
        const dialog = await readFile(`${SRC}app/(app)/mail/connect-dialog.tsx`, "utf8");
        expect(dialog).toContain(
            "if (!resuming || connecting || !ready || !authorizable || !chosenConnection) return;"
        );
        expect(dialog).toContain("connect();");
    });
});
