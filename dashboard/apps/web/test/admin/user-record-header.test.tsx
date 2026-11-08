// @vitest-environment jsdom

/**
 * The name over one person's record comes from the read the open section makes.
 *
 * A header with a read of its own held every section behind it and read the
 * same record twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const actions = vi.hoisted(() => ({
    loadUserSessionsAction: vi.fn(),
    loadUserOverviewAction: vi.fn(),
    loadUserAccessAction: vi.fn(),
    loadUserSecurityAction: vi.fn(),
    loadUserDangerAction: vi.fn()
}));

// Each region asks through the paint route; its name says which read answers.
const reads: Record<string, (id: string) => unknown> = {
    "users.sessions": (id) => actions.loadUserSessionsAction(id),
    "users.overview": (id) => actions.loadUserOverviewAction(id),
    "users.access": (id) => actions.loadUserAccessAction(id),
    "users.security": (id) => actions.loadUserSecurityAction(id),
    "users.danger": (id) => actions.loadUserDangerAction(id)
};
vi.mock("@/app/(app)/admin/paint-read", () => ({
    paintRead: (name: string, query: { id: string }) => reads[name]!(query.id)
}));
vi.mock("@/app/(app)/admin/users/[id]/sessions-section", () => ({
    SessionsSection: ({ user }: { user: { id: string } }) => <p>sessions of {user.id}</p>
}));
vi.mock("@/app/(app)/admin/users/[id]/access-view", () => ({ UserAccessView: () => null }));
vi.mock("@/app/(app)/admin/users/[id]/danger-section", () => ({ DangerSection: () => null }));
vi.mock("@/app/(app)/admin/users/[id]/limits-section", () => ({ LimitsSection: () => null }));
vi.mock("@/app/(app)/admin/users/[id]/overview-controls", () => ({ OverviewControls: () => null }));
vi.mock("@/app/(app)/admin/users/[id]/credentials-section", () => ({
    CredentialsSection: () => null
}));

import {
    UserRecordFrame,
    UserRecordHeader,
    UserSessionsRegion
} from "@/app/(app)/admin/users/[id]/loaders";

const heading = { name: "Ada Lovelace", email: "ada@example.test", isAdmin: false, banned: true };

function record() {
    return render(
        <UserRecordFrame>
            <UserRecordHeader userId="user-1" revision={1} />
            <UserSessionsRegion userId="user-1" revision={1} />
        </UserRecordFrame>
    );
}

beforeEach(() => {
    sessionStorage.clear();
    for (const action of Object.values(actions)) action.mockReset();
});

afterEach(cleanup);

describe("the record header", () => {
    it("draws from the section's answer with no read of its own", async () => {
        let answer: (value: unknown) => void = () => undefined;
        actions.loadUserSessionsAction.mockImplementation(
            () => new Promise((resolve) => (answer = resolve))
        );
        record();
        expect(screen.queryByText("Ada Lovelace")).toBeNull();

        await act(async () => answer({ account: { id: "user-1" }, header: heading }));
        expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
        expect(screen.getByText("sessions of user-1")).toBeTruthy();
        expect(actions.loadUserSessionsAction).toHaveBeenCalledTimes(1);
    });

    it("keeps only what it draws in the tab", async () => {
        actions.loadUserSessionsAction.mockResolvedValue({
            account: { id: "user-1", lastIp: "192.0.2.1" },
            header: heading
        });
        record();
        await screen.findByText("Ada Lovelace");
        const kept = Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key) ?? "");
        expect(kept.some((value) => value.includes("Ada Lovelace"))).toBe(true);
        expect(kept.some((value) => value.includes("192.0.2.1"))).toBe(false);
    });

    it("says nothing of its own when the record is gone, leaving that to the section", async () => {
        actions.loadUserSessionsAction.mockResolvedValue(null);
        record();
        expect(await screen.findAllByText(/notFound/)).toHaveLength(1);
    });

    it("draws no second alert when the section's read fails", async () => {
        actions.loadUserSessionsAction.mockRejectedValue(new Error("down"));
        record();
        expect(await screen.findAllByRole("alert")).toHaveLength(1);
    });

    it("draws the name once the section's retry answers", async () => {
        actions.loadUserSessionsAction.mockRejectedValueOnce(new Error("down"));
        actions.loadUserSessionsAction.mockResolvedValue({
            account: { id: "user-1" },
            header: heading
        });
        record();
        await screen.findByRole("alert");
        await act(async () => fireEvent.click(screen.getByRole("button", { name: /retry/i })));
        expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
        expect(screen.queryByRole("alert")).toBeNull();
    });
});
