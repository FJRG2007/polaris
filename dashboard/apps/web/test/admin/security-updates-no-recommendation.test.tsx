// @vitest-environment jsdom
/**
 * Admin > Updates > Security fixes. The quiet hour is an ordinary answer, not a
 * recommended one: no card steers an administrator to it and no option is
 * labelled as recommended. A deployment that already moved every severity to
 * the quiet hour keeps that schedule, shown with the same accepted-risk line as
 * any other critical or high fix left to wait.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const DEFAULT = { critical: "immediate", high: "immediate", medium: "quiet", low: "quiet", times: {}, riskAccepted: null };
const ALL_QUIET = {
    critical: "quiet",
    high: "quiet",
    medium: "quiet",
    low: "quiet",
    times: {},
    riskAccepted: { by: "admin-1", at: "2026-11-28T10:00:00.000Z" }
};

const loaded = vi.hoisted(() => ({ policy: null as unknown }));
const saveSecurityUpdateAction = vi.fn(async (_input: unknown) => ({ policy: loaded.policy }));
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
    return render(
        <MessagesWrapper>
            <SecurityUpdates />
        </MessagesWrapper>
    );
}

describe("security fix timing without a recommendation", () => {
    it("offers no recommendation on the default schedule", async () => {
        loaded.policy = DEFAULT;
        const { container } = mount();
        // Medium and low already wait for the quiet hour by default.
        expect((await screen.findAllByText(/At the quietest hour/)).length).toBeGreaterThan(0);
        expect(container.textContent).not.toMatch(/recommend/i);
        expect(screen.queryByRole("button", { name: /recommendation/i })).toBeNull();
        expect(screen.queryByText(/An administrator accepted that risk/)).toBeNull();
    });

    it("keeps a schedule that already moved every fix to the quiet hour", async () => {
        loaded.policy = ALL_QUIET;
        const { container } = mount();
        expect(await screen.findByText(/An administrator accepted that risk/)).toBeTruthy();
        expect(screen.getAllByText(/At the quietest hour/)).toHaveLength(4);
        expect(container.textContent).not.toMatch(/recommend|authorized this on/i);
        // Nothing is rewritten on load: the stored answer stands as it was.
        expect(saveSecurityUpdateAction).not.toHaveBeenCalled();
    });
});
