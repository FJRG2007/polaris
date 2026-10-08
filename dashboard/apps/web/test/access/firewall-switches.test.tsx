// @vitest-environment jsdom
/**
 * Flipping a switch on the firewall moves that switch and nothing else.
 *
 * Every switch used to lock the whole page until its save came back: the other
 * switches, the rule list and the buttons went disabled and back, which read as the
 * page flickering under the finger. And each save revalidated the route, so the server
 * re-rendered the page around it too.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

/** Saves that have not answered yet, answered by the test. */
let pending: Array<{
    sent: Record<string, unknown>;
    answer: (result: { error?: string }) => void;
    fail: (reason: Error) => void;
}> = [];
let held: typeof RULE = RULE;

const setWafRuleAction = vi.fn(
    (sent: Record<string, unknown>) =>
        new Promise<{ error?: string }>((answer, fail) => pending.push({ sent, answer, fail }))
);
const getWafRuleAction = vi.fn(async () => ({ rule: held, inherited: null, tor: null }));

vi.mock("../../src/app/(app)/apps/firewall/actions", () => ({
    getWafRuleAction,
    setWafRuleAction,
    getWafRuleMatchesAction: async () => ({ matches: {} }),
    setTorBlockedAction: async () => ({}),
    listWafPrincipalsAction: async () => ({ principals: [] })
}));

const { WafEditor } = await import("../../src/app/(app)/apps/firewall/waf-editor");

async function open() {
    render(
        <MessagesWrapper>
            <WafEditor scopeType="global" scopeId="" />
        </MessagesWrapper>
    );
    const email = await screen.findByRole("switch", { name: "Email address obfuscation" });
    const framing = screen.getByRole("switch", { name: "Block embedding by other sites" });
    return { email, framing };
}

beforeEach(() => {
    pending = [];
    held = RULE;
    setWafRuleAction.mockClear();
    getWafRuleAction.mockClear();
});
afterEach(cleanup);

describe("a firewall switch", () => {
    it("moves at once and leaves every other control usable while it saves", async () => {
        const { email, framing } = await open();
        fireEvent.click(email);
        expect(email.getAttribute("aria-checked")).toBe("false");
        expect(setWafRuleAction).toHaveBeenCalledOnce();
        // The save has not answered, and nothing else on the page waits for it.
        expect(framing.hasAttribute("disabled")).toBe(false);
    });

    it("saves a second switch flipped mid-save after the first, with both changes", async () => {
        const { email, framing } = await open();
        fireEvent.click(email);
        fireEvent.click(framing);
        expect(framing.getAttribute("aria-checked")).toBe("false");
        // One save at a time: the second waits rather than racing the first.
        expect(setWafRuleAction).toHaveBeenCalledOnce();
        pending[0]!.answer({});
        await waitFor(() => expect(setWafRuleAction).toHaveBeenCalledTimes(2));
        expect(pending[1]!.sent).toMatchObject({ emailObfuscation: false, frameProtection: false });
        pending[1]!.answer({});
    });

    it("goes back to what the server holds when the save is refused", async () => {
        const { email } = await open();
        fireEvent.click(email);
        pending[0]!.answer({ error: "Saving the firewall failed." });
        await waitFor(() => expect(email.getAttribute("aria-checked")).toBe("true"));
        expect(await screen.findByText("Saving the firewall failed.")).toBeTruthy();
    });

    it("goes back to what the server holds when the save never answers", async () => {
        const { email, framing } = await open();
        fireEvent.click(email);
        fireEvent.click(framing);
        pending[0]!.fail(new Error("Failed to fetch"));
        await waitFor(() => expect(email.getAttribute("aria-checked")).toBe("true"));
        expect(framing.getAttribute("aria-checked")).toBe("true");
        expect(await screen.findByText("Could not save the firewall rule")).toBeTruthy();
        expect(setWafRuleAction).toHaveBeenCalledOnce();
    });
});
