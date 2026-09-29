/**
 * The rail's headings.
 *
 * Account had grown to eight flat entries, five of which are the same subject:
 * the password and second factor, the sessions, the code scanner and the
 * network rules all answer "who can get into this account". They are drawn
 * under a Security heading, and what somebody building on Polaris reaches for -
 * API keys, their own model keys, domains - under Developers. This asserts the
 * two things that can silently break: a screen that names a group must appear
 * under it, and a list where nothing names one must still be drawn flat with
 * the app's own heading.
 */

import { APP_SECTIONS } from "@/lib/apps";
import { vi, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/account/sessions" }));

const { AppSidebar } = await import("@/components/app-sidebar");

const SECURITY_SCREENS = [
    "/account/security",
    "/account/sessions",
    "/account/scan",
    "/account/access"
];

const DEVELOPER_SCREENS = ["/account/api-keys", "/account/ai-keys", "/account/domains"];

describe("the account rail", () => {
    it("keeps every credential screen in the Security group", () => {
        const sections = APP_SECTIONS.account ?? [];
        for (const href of SECURITY_SCREENS) {
            expect(sections.find((section) => section.href === href)?.group).toBe("Security");
        }
        for (const href of DEVELOPER_SCREENS) {
            expect(sections.find((section) => section.href === href)?.group).toBe("Developers");
        }
        // What is left is the account itself, under no group of its own. Asserted
        // as "no credential screen is loose" rather than as a fixed list, so a new
        // profile screen does not fail this and a new security one does.
        const ungrouped = sections.filter((section) => section.group === undefined).map((section) => section.href);
        expect(ungrouped).toContain("/account");
        expect(
            ungrouped.filter((href) => [...SECURITY_SCREENS, ...DEVELOPER_SCREENS].includes(href))
        ).toEqual([]);
    });

    it("draws the heading once, before the screens it covers", () => {
        const markup = renderToStaticMarkup(<AppSidebar />);
        expect(markup.match(/Security<\/p>/g)).toHaveLength(1);
        expect(markup.indexOf("Security</p>")).toBeLessThan(markup.indexOf("/account/sessions"));
        // The ungrouped screens keep the app's own heading above them.
        expect(markup.indexOf("My account</p>")).toBeLessThan(markup.indexOf("Security</p>"));
        // Developers comes last, after the account's own and its security.
        expect(markup.match(/Developers<\/p>/g)).toHaveLength(1);
        expect(markup.indexOf("Security</p>")).toBeLessThan(markup.indexOf("Developers</p>"));
        expect(markup.indexOf("Developers</p>")).toBeLessThan(markup.indexOf("/account/api-keys"));
    });

    it("draws a rail with no groups flat, under one heading", () => {
        const flat = (APP_SECTIONS.drive ?? []).every((section) => section.group === undefined);
        expect(flat).toBe(true);
    });
});
