/**
 * Writing takes a mailbox to write from, and what is typed stays typed.
 *
 * Two reports from using it: Write opened a composer with an empty From when no
 * mailbox was connected, and the recipients vanished a few seconds into typing
 * the subject - the draft's autosave refreshed the screen, the refresh handed the
 * composer new mailbox objects, and the composer took that as a new message.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SCREENS = new URL("../../src/app/(app)/mail/", import.meta.url);

describe("writing with no mailbox", () => {
    it("sends every way in to connecting one", async () => {
        const shell = await readFile(new URL("mail-shell.tsx", SCREENS), "utf8");
        expect(shell).toContain('CONNECT_MAILBOX_HREF = "/mail/settings/accounts?connect=1"');
        // The one gate every caller goes through: Write, the shortcut, a reply.
        expect(shell).toMatch(/if \(draft && !hasMailbox\) \{\s*router\.push\(CONNECT_MAILBOX_HREF\);/);
        expect(shell).toContain('{hasMailbox ? "Write" : "Connect a mailbox"}');
        // Nothing hands the raw setter out any more.
        expect(shell).not.toContain("openComposer: setComposing");
    });

    it("sends a mailto link there too, rather than to an empty inbox", async () => {
        const link = await readFile(new URL("compose/open-from-link.tsx", SCREENS), "utf8");
        expect(link).toMatch(/if \(!hasMailbox\) \{\s*router\.replace\(CONNECT_MAILBOX_HREF/);
    });

    it("opens the connect dialog when it arrives", async () => {
        const page = await readFile(new URL("settings/accounts/page.tsx", SCREENS), "utf8");
        expect(page).toContain('connectNow={params.connect === "1"}');
        const view = await readFile(new URL("settings/accounts/accounts-view.tsx", SCREENS), "utf8");
        expect(view).toContain("useState(connectNow)");
    });

    it("never draws a composer with nowhere to send from", async () => {
        const composer = await readFile(new URL("composer.tsx", SCREENS), "utf8");
        expect(composer).toContain("if (!composing || accounts.length === 0) return null;");
    });

    it("runs every hook before it draws nothing", async () => {
        // The composer is mounted with no draft open. A hook after that return
        // runs only once a draft opens, which is one more hook than the render
        // before - and React takes the whole mail screen down on the Reply press.
        const composer = await readFile(new URL("composer.tsx", SCREENS), "utf8");
        const quiet = composer.indexOf("if (!composing || accounts.length === 0) return null;");
        const tail = composer.slice(quiet, composer.indexOf("\nfunction ", quiet));
        expect(quiet).toBeGreaterThan(0);
        expect(tail).not.toMatch(/\buse[A-Z]\w*\(/);
    });
});

describe("a composer being typed in", () => {
    it("is seeded by a new message only, not by a refreshed screen", async () => {
        const composer = await readFile(new URL("composer.tsx", SCREENS), "utf8");
        expect(composer).toContain("if (seeded.current === composing) return;");
    });
});
