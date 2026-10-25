// @vitest-environment jsdom
/**
 * A scope whose own login switch is off, over services that already require one.
 *
 * The project's row used to read "Off" while every service in it sat behind a login
 * a narrower rule or a private address had switched on - true of the project's rule,
 * and the opposite of what a visitor meets.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const RULE = {
    ipAllowlist: [],
    ipDenylist: [],
    requireLogin: false,
    loginAllowPrincipals: [],
    loginDenyPrincipals: [],
    browserIntegrity: false,
    sqlInjectionProtection: true,
    xssProtection: true,
    emailObfuscation: true,
    frameProtection: true,
    frameAncestors: [],
    presets: [],
    rules: []
};
const SERVICE = "00000000-0000-7000-8000-0000000000a1";

let below: { id: string; name: string; via: string; owned: boolean }[] = [];
let count: number | null = null;

vi.mock("../../src/app/(app)/apps/deploy/restore-actions", () => ({
    listHistoryAction: async () => ({ points: [] }),
    restoreHistoryAction: async () => ({})
}));
vi.mock("../../src/app/(app)/apps/firewall/actions", () => ({
    getWafRuleAction: async () => ({
        rule: RULE,
        inherited: null,
        loginBelow: { count: count ?? below.length, services: below },
        tor: null
    }),
    setWafRuleAction: async () => ({}),
    getWafRuleMatchesAction: async () => ({ matches: {} }),
    setTorBlockedAction: async () => ({}),
    findWafPeopleAction: async () => ({ results: [] }),
    listWafPrincipalsAction: async () => ({ principals: [] }),
    getDirectAccessAction: async () => ({ reachable: [] }),
    closeDirectAccessAction: async () => ({ closed: 0, failed: 0 })
}));

const { WafEditor } = await import("../../src/app/(app)/apps/firewall/waf-editor");

async function loginRow() {
    render(
        <MessagesWrapper>
            <WafEditor scopeType="project" scopeId="00000000-0000-7000-8000-0000000000p1" />
        </MessagesWrapper>
    );
    const name = await screen.findByRole("button", { name: "Require Polaris login" });
    return name.closest("tr")!;
}

afterEach(() => {
    below = [];
    count = null;
    cleanup();
});

describe("the login row over services that already require one", () => {
    it("says how many services sign in instead of Off, and keeps its own switch live", async () => {
        below = [
            { id: SERVICE, name: "web", via: "application", owned: true },
            { id: "00000000-0000-7000-8000-0000000000a2", name: "api", via: "private", owned: true }
        ];
        const row = await loginRow();
        expect(within(row).getByText("On for 2 services")).toBeTruthy();
        expect(within(row).queryByText("Off")).toBeNull();
        const toggle = within(row).getByRole("switch");
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        expect(toggle.hasAttribute("disabled")).toBe(false);
    });

    it("lists those services on the rule's page, each linked to its own rules", async () => {
        below = [{ id: SERVICE, name: "web", via: "environment", owned: true }];
        const row = await loginRow();
        fireEvent.click(within(row).getByRole("button", { name: "Require Polaris login" }));
        const link = await screen.findByRole("link", { name: "web" });
        expect(link.getAttribute("href")).toBe(`/apps/firewall?scope=application&id=${SERVICE}`);
        expect(screen.getByText("Its environment")).toBeTruthy();
    });

    it("still says Off when nothing under it requires a login", async () => {
        const row = await loginRow();
        expect(within(row).getByText("Off")).toBeTruthy();
    });

    it("names a few services in the row's tooltip and counts the rest", async () => {
        below = ["a", "b", "c", "d", "e", "f"].map((name, index) => ({
            id: `00000000-0000-7000-8000-00000000000${index}`,
            name,
            via: "application",
            owned: true
        }));
        count = 900;
        const row = await loginRow();
        expect(within(row).getByText("On for 900 services").getAttribute("title")).toBe(
            "a, b, c, d, e and 895 more"
        );
    });

    it("shows a service the caller does not own without a link, and counts what is not listed", async () => {
        below = [{ id: SERVICE, name: "theirs", via: "application", owned: false }];
        count = 3;
        const row = await loginRow();
        fireEvent.click(within(row).getByRole("button", { name: "Require Polaris login" }));
        expect(await screen.findByText("theirs")).toBeTruthy();
        expect(screen.queryByRole("link", { name: "theirs" })).toBeNull();
        expect(screen.getByText("And 2 more")).toBeTruthy();
    });
});
