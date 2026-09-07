/**
 * Authorizing a mailbox needs an address the provider can return you to.
 *
 * On a LAN-only install the dashboard is called something only this network
 * knows - `http://polaris.local` - and that is what Polaris hands a provider as
 * the address to come back to. Google will not take it. What somebody got was a
 * consent screen that authorized nothing followed by a browser sitting on an
 * address it could not resolve, which reads as the mail app being broken rather
 * than as the dashboard having no public name. Gmail could not be connected at
 * all, and nothing on screen said why.
 *
 * So the trip is refused before it starts, and every screen that offers it draws
 * the reason instead of the button.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { publicHostname } from "@/lib/domain-edge";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("what counts as an address a provider can reach", () => {
    it("refuses the names only one network knows", () => {
        for (const value of [
            "http://polaris.local",
            "https://polaris.local",
            "http://polaris.lan",
            "https://box.internal",
            "http://localhost:3000",
            "https://192.168.1.142",
            "http://polaris"
        ]) {
            expect(publicHostname(value), value).toBeNull();
        }
    });

    it("accepts a real one", () => {
        expect(publicHostname("https://polaris.example.com/")).toBe("polaris.example.com");
    });
});

describe("the flow refuses a trip it cannot finish", () => {
    it("checks before sending anybody to the provider", async () => {
        const flow = await readFile(`${SRC}lib/connections/link-flow.ts`, "utf8");
        expect(flow).toContain('if (mode !== "signin" && !(await publicAppUrl()))');
        // Its own outcome, so the screen can explain this rather than saying the
        // authorization "did not finish" - which is true and useless.
        expect(flow).toContain('"not_public"');
    });

    it("stops the button being drawn at all", async () => {
        const options = await readFile(`${SRC}lib/mailbox/connect-options.ts`, "utf8");
        expect(options).toContain("googleReady: Boolean(google?.enabled && google.hasSecret && publicUrl)");
        expect(options).toContain(
            "microsoftReady: Boolean(microsoft?.enabled && microsoft.hasSecret && publicUrl)"
        );
    });

    it("says why, where the button would have been", async () => {
        const dialog = await readFile(`${SRC}app/(app)/mail/connect-dialog.tsx`, "utf8");
        expect(dialog).toContain("discovery.oauth && !publicAddress");
        expect(dialog).toContain("/admin/domains");
        // And for somebody who cannot set it themself, who to ask.
        expect(dialog).toContain("Ask an administrator to give Polaris a public address.");
    });
});
