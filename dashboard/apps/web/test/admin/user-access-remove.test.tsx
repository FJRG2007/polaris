// @vitest-environment jsdom

/**
 * Removing one person's access to one thing, with the real confirmation dialog.
 *
 * Asking from inside a React transition holds the dialog back until the
 * transition ends, so the button spins forever. A test that replaces the dialog
 * cannot see that, which is why this one does not.
 */

import * as actions from "@/app/(app)/admin/users/[id]/actions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserAccessView } from "@/app/(app)/admin/users/[id]/access-view";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

vi.mock("@/app/(app)/admin/users/actions", () => ({ setUserRoleAction: vi.fn() }));

vi.mock("@/app/(app)/admin/users/[id]/capabilities-card", () => ({ CapabilitiesCard: () => null }));

vi.mock("@/app/(app)/admin/users/[id]/actions", () => ({
    removeUserGrantAction: vi.fn(),
    setUserGroupAction: vi.fn(),
    setUserPolicyAction: vi.fn(),
    userAccessAction: vi.fn()
}));

const GRANT = {
    id: "grant-1",
    kind: "install" as const,
    kindLabel: "Server",
    resourceId: "server-1",
    resourceLabel: "Survival",
    principalType: "user",
    principalLabel: "someone",
    actions: [],
    effect: "allow" as const,
    canShare: false,
    expiresAt: null,
    expired: false,
    href: null
};

beforeEach(() => {
    vi.mocked(actions.userAccessAction).mockResolvedValue({
        access: { isAdmin: false, global: [], resources: [GRANT] }
    });
    vi.mocked(actions.removeUserGrantAction).mockResolvedValue({});
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

function view() {
    render(
        <UserAccessView
            userId="user-1"
            role={null}
            roles={[]}
            groups={[]}
            memberOf={[]}
            policies={[]}
            attachedPolicies={[]}
        />
    );
}

describe("removing access to one thing", () => {
    it("shows the dialog, and removes on its answer", async () => {
        view();
        fireEvent.click(await screen.findByRole("button", { name: "Remove their access to Survival" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
        await waitFor(() =>
            expect(actions.removeUserGrantAction).toHaveBeenCalledWith("user-1", "grant-1", "install:server-1")
        );
    });

    it("says so when the removal fails, instead of spinning", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.mocked(actions.removeUserGrantAction).mockRejectedValue(new Error("server action not found"));
        view();
        fireEvent.click(await screen.findByRole("button", { name: "Remove their access to Survival" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
        expect(await screen.findByText(/Polaris did not answer/)).toBeTruthy();
        expect(screen.getByRole("button", { name: "Remove their access to Survival" })).toHaveProperty(
            "disabled",
            false
        );
    });
});
