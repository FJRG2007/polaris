// @vitest-environment jsdom

/**
 * Inviting somebody to one thing rather than to everything.
 *
 * Grants live on spaces and on folders. Lists and sprints have none of their
 * own, and the dangerous version of this screen is the one that draws a sharing
 * box on a list, writes the grant a level up, and says nothing - somebody hands
 * out one list and finds out later what else went with it. So the dialog names
 * what was asked about and what is actually being changed, in that order.
 *
 * The other half is who may change it. That answer comes back with the list
 * rather than from the screen that opened the dialog: a tree knows the role of
 * the row that was clicked and the sprints screen does not, and a caller working
 * it out for itself is a caller that can draw a button the server will refuse.
 */

import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const listSpaceMembersAction = vi.fn();
const listFolderMembersAction = vi.fn();

vi.mock("@/app/(app)/tasks/actions", () => ({
    listSpaceMembersAction: (id: string) => listSpaceMembersAction(id),
    listFolderMembersAction: (id: string) => listFolderMembersAction(id),
    spaceTeamsAction: async () => ({ granted: [], available: [] }),
    folderTeamsAction: async () => ({ granted: [], available: [] }),
    addSpaceMemberAction: async () => ({}),
    addFolderMemberAction: async () => ({}),
    setSpaceMemberRoleAction: async () => ({}),
    setFolderMemberRoleAction: async () => ({}),
    removeSpaceMemberAction: async () => ({}),
    removeFolderMemberAction: async () => ({}),
    grantSpaceTeamAction: async () => ({}),
    grantFolderTeamAction: async () => ({}),
    revokeSpaceTeamAction: async () => ({}),
    revokeFolderTeamAction: async () => ({})
}));

const { AccessDialog } = await import("@/app/(app)/tasks/access-dialog");

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

const OWNER = { userId: "u1", name: "Ada", contact: "ada@example.com", image: null, role: "owner" as const };
const MEMBER = { userId: "u2", name: "Bo", contact: "bo@example.com", image: null, role: "member" as const };

function spaceAnswer(canManage: boolean) {
    return { space: { id: "s1", name: "Product" }, members: [OWNER, MEMBER], canManage };
}

function folderAnswer(canManage: boolean) {
    return {
        folder: { id: "f1", name: "Acme", path: [{ id: "f1", name: "Acme" }] },
        members: [{ ...MEMBER, folderId: "f1", folderName: "Acme", inherited: false }],
        canManage
    };
}

describe("a list, which has no access of its own", () => {
    it("says it is reached through the folder it sits in, before saying what that does", async () => {
        listFolderMembersAction.mockResolvedValue(folderAnswer(true));
        render(
            <AccessDialog
                target={{ scope: { kind: "folder", id: "f1" }, asked: { kind: "list", name: "Backlog" } }}
                onClose={() => {}}
            />
        );

        const said = await screen.findByText(/has no access of its own/);
        expect(said.textContent).toContain("Backlog");
        expect(said.textContent).toContain("folder");
        // And what the grant will actually reach, so nobody hands out a list
        // without reading what came with it.
        expect(screen.getByText(/reach this folder and everything inside it/)).toBeTruthy();
        expect(listFolderMembersAction).toHaveBeenCalledWith("f1");
    });

    it("opens on the space when the list sits in no folder", async () => {
        listSpaceMembersAction.mockResolvedValue(spaceAnswer(true));
        render(
            <AccessDialog
                target={{ scope: { kind: "space", id: "s1" }, asked: { kind: "list", name: "Inbox" } }}
                onClose={() => {}}
            />
        );

        const said = await screen.findByText(/has no access of its own/);
        expect(said.textContent).toContain("the space");
        expect(screen.getByText(/reach everything in this space/)).toBeTruthy();
    });
});

describe("a sprint", () => {
    it("is reached through the folder whose work it plans", async () => {
        listFolderMembersAction.mockResolvedValue(folderAnswer(true));
        render(
            <AccessDialog
                target={{ scope: { kind: "folder", id: "f1" }, asked: { kind: "sprint", name: "Sprint 12" } }}
                onClose={() => {}}
            />
        );

        const said = await screen.findByText(/has no access of its own/);
        expect(said.textContent).toContain("Sprint 12");
    });
});

describe("who may change it", () => {
    it("offers the invite form when the server says this caller may", async () => {
        listSpaceMembersAction.mockResolvedValue(spaceAnswer(true));
        render(<AccessDialog target={{ scope: { kind: "space", id: "s1" } }} onClose={() => {}} />);

        await waitFor(() => expect(screen.getByRole("button", { name: /invite/i })).toBeTruthy());
    });

    it("draws it read-only when the server says they may not, whatever the screen thought", async () => {
        listSpaceMembersAction.mockResolvedValue(spaceAnswer(false));
        render(<AccessDialog target={{ scope: { kind: "space", id: "s1" } }} onClose={() => {}} />);

        await screen.findByText("Bo");
        expect(screen.queryByRole("button", { name: /invite/i })).toBeNull();
        expect(screen.queryByLabelText("Remove Bo")).toBeNull();
    });

    it("never offers to take the space off its owner", async () => {
        listSpaceMembersAction.mockResolvedValue(spaceAnswer(true));
        render(<AccessDialog target={{ scope: { kind: "space", id: "s1" } }} onClose={() => {}} />);

        await screen.findByText("Ada");
        // Bo can be removed; the owner is not a grant and cannot be one - taking
        // the role off them would leave the space with nobody who owns it.
        expect(screen.getByLabelText("Remove Bo")).toBeTruthy();
        expect(screen.queryByLabelText("Remove Ada")).toBeNull();
    });
});

describe("a grant made further up", () => {
    it("is listed and left alone, so nobody re-invites somebody who is already here", async () => {
        listFolderMembersAction.mockResolvedValue({
            folder: { id: "f2", name: "Website", path: [{ id: "f1", name: "Acme" }, { id: "f2", name: "Website" }] },
            members: [{ ...MEMBER, folderId: "f1", folderName: "Acme", inherited: true }],
            canManage: true
        });
        render(<AccessDialog target={{ scope: { kind: "folder", id: "f2" } }} onClose={() => {}} />);

        await screen.findByText("Bo");
        expect(screen.getByText("Through Acme")).toBeTruthy();
        expect(screen.queryByLabelText("Remove Bo")).toBeNull();
    });
});

describe("closing", () => {
    it("asks nothing until it is opened", async () => {
        render(<AccessDialog target={null} onClose={() => {}} />);
        await Promise.resolve();
        expect(listSpaceMembersAction).not.toHaveBeenCalled();
        expect(listFolderMembersAction).not.toHaveBeenCalled();
    });

    it("is dismissable with the keyboard", async () => {
        const user = userEvent.setup();
        const closed = vi.fn();
        listSpaceMembersAction.mockResolvedValue(spaceAnswer(true));
        render(<AccessDialog target={{ scope: { kind: "space", id: "s1" } }} onClose={closed} />);

        await screen.findByText("Ada");
        await user.keyboard("{Escape}");
        expect(closed).toHaveBeenCalled();
    });
});
