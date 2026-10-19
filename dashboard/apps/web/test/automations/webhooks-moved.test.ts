/**
 * The Webhooks screen moved from the account to Automations: the old address
 * still lands on the new one - as a redirect before anything is drawn, not a
 * page under a loading boundary - and the navigation only points at the new place.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { APP_SECTIONS } from "@/lib/apps";
import config from "../../next.config.mjs";
import { describe, expect, it } from "vitest";

describe("the old webhooks address", () => {
    it("redirects to /automations/webhooks, temporarily", async () => {
        const rules = await config.redirects();
        expect(rules).toContainEqual({
            source: "/account/webhooks",
            destination: "/automations/webhooks",
            permanent: false
        });
    });

    it("has no page left to shadow the redirect, and the new one exists", () => {
        const app = join(process.cwd(), "src/app/(app)");
        expect(existsSync(join(app, "account/webhooks/page.tsx"))).toBe(false);
        expect(existsSync(join(app, "automations/webhooks/page.tsx"))).toBe(true);
    });

    it("is no longer linked from any navigation section", () => {
        const hrefs = Object.values(APP_SECTIONS).flatMap((sections) =>
            sections.map((section) => section.href)
        );
        expect(hrefs).not.toContain("/account/webhooks");
        expect(APP_SECTIONS.automations?.map((section) => section.href)).toContain(
            "/automations/webhooks"
        );
    });
});
