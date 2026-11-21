// @vitest-environment jsdom
/**
 * The access rules panel on /account/access: the list, the examples an empty
 * list offers, a rule opened as its page and saved, a save the server refuses
 * for locking out this session (shown where it was made), and a toggle put back
 * when the server refuses it.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { AccountRule } from "@polaris/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const actions = vi.hoisted(() => ({
    save: vi.fn(async (_rules: unknown): Promise<{ error?: string; lockout?: unknown }> => ({})),
    preview: vi.fn(async (_rules: unknown): Promise<unknown> => ({
        preview: { action: "allow", ruleName: null, ip: "203.0.113.9", country: "ES", browser: "Firefox", os: "Linux" }
    }))
}));
vi.mock("@/app/(app)/account/access/rule-actions", () => ({
    saveAccountRulesAction: actions.save,
    previewAccountRulesAction: actions.preview
}));

const { AccountRulesPanel } = await import("@/app/(app)/account/access/rules-panel");

const LIST = { id: "00000000-0000-4000-8000-000000000001", name: "Office" };
const RULE: AccountRule = {
    name: "No Apple",
    enabled: true,
    action: "block",
    timeZone: "UTC",
    conditions: [{ field: "os", operator: "equals", values: ["iOS", "macOS"] }]
};

function open(rules: AccountRule[] = [RULE]) {
    render(
        <MessagesWrapper>
            <AccountRulesPanel initialRules={rules} lists={[LIST]} reputation={false} />
        </MessagesWrapper>
    );
}

beforeEach(() => {
    actions.save.mockClear();
    actions.preview.mockClear();
    actions.save.mockImplementation(async () => ({}));
});
afterEach(cleanup);

describe("the access rules panel", () => {
    it("lists a rule with its order, action badge and description", () => {
        open();
        expect(screen.getByText("Your rules")).toBeTruthy();
        expect(screen.getByRole("button", { name: "No Apple" })).toBeTruthy();
        expect(screen.getByText("Block")).toBeTruthy();
        expect(screen.getByText("Operating system is one of iOS, macOS")).toBeTruthy();
    });

    it("offers examples when there are no rules, and one opens prefilled without saving", () => {
        open([]);
        expect(screen.getByText("Only from my country")).toBeTruthy();
        expect(screen.getByText("Block VPN, proxy and Tor")).toBeTruthy();
        fireEvent.click(screen.getByText("Block iPhone and Mac"));
        expect(screen.getByText("New access rule")).toBeTruthy();
        expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Block iPhone and Mac");
        expect(actions.save).not.toHaveBeenCalled();
    });

    it("saves an edited rule as the whole list", async () => {
        open();
        fireEvent.click(screen.getByRole("button", { name: "No Apple" }));
        fireEvent.change(screen.getByLabelText("Name"), { target: { value: "No Mac" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(actions.save).toHaveBeenCalledTimes(1));
        expect(actions.save.mock.calls[0]![0]).toEqual([{ ...RULE, name: "No Mac" }]);
        await waitFor(() => expect(screen.getByText("Your rules")).toBeTruthy());
    });

    it("shows a lockout refusal inline, with the session it would block, and stays on the page", async () => {
        actions.save.mockImplementation(async () => ({
            error: "Not saved: the rule \"No Mac\" would block the session you are using right now.",
            lockout: { action: "block", ruleName: "No Mac", ip: "203.0.113.9", country: "ES", browser: "Safari", os: "macOS" }
        }));
        open();
        fireEvent.click(screen.getByRole("button", { name: "No Apple" }));
        fireEvent.change(screen.getByLabelText("Name"), { target: { value: "No Mac" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain("would block the session");
        expect(alert.textContent).toContain("203.0.113.9");
        expect(screen.getByText("Edit access rule")).toBeTruthy();
    });

    it("tests the draft against the current session", async () => {
        open();
        fireEvent.click(screen.getByRole("button", { name: "No Apple" }));
        fireEvent.click(screen.getByRole("button", { name: "Run test" }));
        expect((await screen.findByRole("status")).textContent).toContain("No rule matches");
        expect(actions.preview.mock.calls[0]![0]).toEqual([RULE]);
    });

    it("puts a toggle back when the server refuses it", async () => {
        actions.save.mockImplementation(async () => ({ error: "Refused." }));
        open();
        const toggle = screen.getByRole("switch", { name: "Disable No Apple" });
        fireEvent.click(toggle);
        expect(await screen.findByText("Refused.")).toBeTruthy();
        expect(actions.save.mock.calls[0]![0]).toEqual([{ ...RULE, enabled: false }]);
        expect(screen.getByRole("switch", { name: "Disable No Apple" })).toBeTruthy();
    });

    it("refuses to save a rule with an empty condition", () => {
        open();
        fireEvent.click(screen.getByText("Create rule"));
        fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Night" } });
        expect(screen.getByText("Give every condition at least one value.")).toBeTruthy();
        expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    });
});
