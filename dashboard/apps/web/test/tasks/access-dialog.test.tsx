// @vitest-environment jsdom

/**
 * Inviting somebody to one thing rather than to everything, in the share dialog
 * every other thing in Polaris is handed over with.
 *
 * Grants live on spaces and on folders. Lists and sprints have none of their
 * own, and the dangerous version of this screen is the one that draws a sharing
 * box on a list, writes the grant a level up, and says nothing - somebody hands
 * out one list and finds out later what else went with it. So the dialog names
 * what was asked about and what is actually being changed, in that order.
 *
 * Who has it, and changing that, is the share dialog's own: subject
 * `task.space` or `task.folder`, written to AccessGrant. What Tasks adds is the
 * grants made further up, listed read-only.
 */

import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const share = {
    shareSetupAction: vi.fn(),
    grantPageAction: vi.fn(),
    findShareTargetsAction: vi.fn(async () => ({ targets: [] })),
    shareManyAction: vi.fn(),
    updateShareAction: vi.fn(),
    revokeShareAction: vi.fn(),
    setLinkAudienceAction: vi.fn(),
    shareLinkAction: vi.fn()
};
vi.mock("@/app/(app)/access-actions", () => share);
vi.mock("@/components/access/access-log", () => ({ AccessLog: () => null }));
vi.mock("@/components/confirm-dialog", () => ({
    useConfirm: () => [async () => true, null]
}));

const accessDetailAction = vi.fn();
vi.mock("@/app/(app)/tasks/actions", () => ({
    accessDetailAction: (kind: string, id: string) => accessDetailAction(kind, id)
}));

const { MessagesWrapper } = await import("../setup/i18n");
const { AccessDialog } = await import("@/app/(app)/tasks/access-dialog");

const row = (id: string, name: string, capability = "member") => ({
    id,
    principalType: "user",
    principalId: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
    principalName: name,
    orgName: "",
    capability,
    actions: [],
    standing: "live",
    until: null,
    schedule: {
        startsAt: null,
        endsAt: null,
        days: 127,
        startMinute: null,
        endMinute: null,
        timeZone: "",
        maxUses: null,
        uses: 0,
        nearbyMeters: null
    },
    note: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    audience: "anyone",
    password: false,
    contact: `@${name.toLowerCase()}`
});

beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
        width: 360,
        height: 288,
        top: 0,
        left: 0,
        right: 360,
        bottom: 288,
        x: 0,
        y: 0,
        toJSON: () => ({})
    } as DOMRect);
    Element.prototype.scrollIntoView = () => {};
    share.shareSetupAction.mockResolvedValue({
        setup: {
            viewer: { id: "me", name: "Maria", email: "maria@example.test" },
            owner: { id: "o1", name: "Ada", contact: "@ada" },
            candidates: [],
            located: null,
            org: null,
            url: null
        }
    });
    share.grantPageAction.mockImplementation(
        async (_s: string, _id: string, q: { links?: boolean }) =>
            q.links
                ? { page: { grants: [], total: 0, nextCursor: null } }
                : { page: { grants: [row("2", "Bo")], total: 1, nextCursor: null } }
    );
    accessDetailAction.mockResolvedValue({ name: "Product", path: "", inherited: [] });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe("the access dialog is the share dialog", () => {
    it("shares a space as task.space, with the owner, the rows and the one box", async () => {
        render(<AccessDialog target={{ scope: { kind: "space", id: "s1" } }} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });

        expect(await screen.findByText("Bo")).toBeTruthy();
        expect(await screen.findByText("Ada")).toBeTruthy();
        expect(screen.getByRole("combobox", { name: "Add people, teams or roles" })).toBeTruthy();
        expect(share.shareSetupAction).toHaveBeenCalledWith("task.space", "s1");
        expect(share.grantPageAction).toHaveBeenCalledWith("task.space", "s1", expect.anything());
        expect(accessDetailAction).toHaveBeenCalledWith("space", "s1");
        await screen.findByText(/Product/);
    });

    it("shares a folder as task.folder", async () => {
        accessDetailAction.mockResolvedValue({ name: "Acme", path: "Acme", inherited: [] });
        render(<AccessDialog target={{ scope: { kind: "folder", id: "f1" } }} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });

        await screen.findByText("Bo");
        expect(share.shareSetupAction).toHaveBeenCalledWith("task.folder", "f1");
    });
});

describe("a list, which has no access of its own", () => {
    it("says it is reached through the folder it sits in, before saying what that does", async () => {
        accessDetailAction.mockResolvedValue({ name: "Acme", path: "Acme", inherited: [] });
        render(
            <AccessDialog
                target={{ scope: { kind: "folder", id: "f1" }, asked: { kind: "list", name: "Launch" } }}
                onClose={() => {}}
            />,
            { wrapper: MessagesWrapper }
        );

        const asked = await screen.findByText(/has no access of its own/);
        const reach = screen.getByText(/reach this folder and everything inside it/);
        expect(asked.textContent).toContain("Launch");
        // The sentence about the list comes first in the document.
        expect(asked.compareDocumentPosition(reach) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});

describe("a grant made further up", () => {
    it("is listed and left alone, so nobody re-invites somebody who is already here", async () => {
        accessDetailAction.mockResolvedValue({
            name: "Website",
            path: "Acme / Website",
            inherited: [
                {
                    principalType: "user",
                    principalId: "u9",
                    name: "Cy",
                    capability: "guest",
                    through: "Acme"
                }
            ]
        });
        render(<AccessDialog target={{ scope: { kind: "folder", id: "f2" } }} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });

        expect(await screen.findByText("Cy")).toBeTruthy();
        expect(screen.getByText("Through Acme")).toBeTruthy();
        // Read-only: no role menu on an inherited row.
        expect(screen.queryByRole("combobox", { name: /Cy/ })).toBeNull();
    });
});

describe("closing", () => {
    it("asks nothing until it is opened", async () => {
        render(<AccessDialog target={null} onClose={() => {}} />, { wrapper: MessagesWrapper });
        await Promise.resolve();
        expect(accessDetailAction).not.toHaveBeenCalled();
        expect(share.shareSetupAction).not.toHaveBeenCalled();
    });

    it("is dismissable with the keyboard", async () => {
        const user = userEvent.setup();
        const closed = vi.fn();
        render(<AccessDialog target={{ scope: { kind: "space", id: "s1" } }} onClose={closed} />, {
            wrapper: MessagesWrapper
        });

        await screen.findByText("Bo");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(closed).toHaveBeenCalled());
    });
});
