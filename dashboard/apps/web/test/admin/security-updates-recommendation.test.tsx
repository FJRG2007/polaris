// @vitest-environment jsdom
/**
 * Admin > Updates > Security fixes. Critical and high install at once by
 * default; Polaris recommends the quiet hour for every severity and offers it
 * in one button, which saves through the same action as any other change and
 * sends the administrator's authorization with it. Once applied the card goes
 * and the schedule says who authorized it.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const DEFAULT = { critical: "immediate", high: "immediate", medium: "quiet", low: "quiet", times: {}, riskAccepted: null };
const AUTHORIZED = {
    critical: "quiet",
    high: "quiet",
    medium: "quiet",
    low: "quiet",
    times: {},
    riskAccepted: { by: "admin-1", at: "2026-11-28T10:00:00.000Z" }
};

const loaded = vi.hoisted(() => ({ policy: null as unknown }));
const saveSecurityUpdateAction = vi.fn(async (_input: unknown) => ({ policy: AUTHORIZED }));
vi.mock("@/app/(app)/admin/updates/actions", () => ({
    securityUpdatePolicyAction: async () => ({ policy: loaded.policy, quietHour: 2 }),
    saveSecurityUpdateAction: (input: unknown) => saveSecurityUpdateAction(input)
}));

const { SecurityUpdates } = await import("@/app/(app)/admin/updates/security-updates");

afterEach(() => {
    cleanup();
    saveSecurityUpdateAction.mockClear();
});

function mount() {
    render(
        <MessagesWrapper>
            <SecurityUpdates />
        </MessagesWrapper>
    );
}

describe("the quiet-hour recommendation", () => {
    it("is offered while critical or high install at once, and applies with the authorization", async () => {
        loaded.policy = DEFAULT;
        mount();
        const apply = await screen.findByRole("button", { name: "Apply recommendation" });
        expect(screen.getByText("Recommended: install every fix at the quietest hour")).toBeTruthy();
        fireEvent.click(apply);
        await waitFor(() => expect(saveSecurityUpdateAction).toHaveBeenCalledTimes(1));
        expect(saveSecurityUpdateAction.mock.calls[0]![0]).toMatchObject({
            critical: "quiet",
            high: "quiet",
            medium: "quiet",
            low: "quiet",
            acceptRisk: true
        });
        await waitFor(() => expect(screen.queryByRole("button", { name: "Apply recommendation" })).toBeNull());
        expect(screen.getByText(/An administrator authorized this on/)).toBeTruthy();
    });

    it("is not offered once every severity waits for the quiet hour", async () => {
        loaded.policy = AUTHORIZED;
        mount();
        await screen.findByText(/An administrator authorized this on/);
        expect(screen.queryByRole("button", { name: "Apply recommendation" })).toBeNull();
        expect(screen.queryByText(/An administrator accepted that risk/)).toBeNull();
    });
});
