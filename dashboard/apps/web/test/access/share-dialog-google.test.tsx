// @vitest-environment jsdom
/**
 * The share dialog: you first, then the rows, then General access; a role
 * change and a removal are optimistic and put back on a refusal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@polaris/db", () => ({ prisma: {} }));

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
    contact: `@${name.toLowerCase()}`
});

const actions = {
    shareSetupAction: vi.fn(),
    grantPageAction: vi.fn(),
    findShareTargetsAction: vi.fn(async () => ({ targets: [] })),
    shareManyAction: vi.fn(),
    updateShareAction: vi.fn(),
    revokeShareAction: vi.fn(),
    setLinkAudienceAction: vi.fn(),
    shareLinkAction: vi.fn()
};
vi.mock("@/app/(app)/access-actions", () => actions);
vi.mock("@/components/access/access-log", () => ({ AccessLog: () => null }));
let confirmAnswer = true;
vi.mock("@/components/confirm-dialog", () => ({
    useConfirm: () => [async () => confirmAnswer, null]
}));

const { MessagesWrapper } = await import("../setup/i18n");
const { ShareDialog } = await import("@/components/access/share-dialog");

beforeEach(() => {
    // jsdom lays nothing out; the list's scroller gets a phone-sized box.
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
    confirmAnswer = true;
    actions.shareSetupAction.mockResolvedValue({
        setup: {
            viewer: { id: "me", name: "Maria", email: "maria@example.test" },
            candidates: [],
            located: null,
            org: null,
            url: "https://polaris.example.test/tasks/s/1"
        }
    });
    actions.grantPageAction.mockImplementation(async (_s: string, _id: string, q: { links?: boolean }) =>
        q.links
            ? { page: { grants: [], total: 0, nextCursor: null } }
            : {
                  page: {
                      grants: [row("1", "Ana"), row("2", "Luis")],
                      total: 1284,
                      nextCursor: null
                  }
              }
    );
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

const open = () =>
    render(
        <ShareDialog open onOpenChange={() => {}} subject="task.space" subjectId="s1" name="Indoor Studio" />,
        { wrapper: MessagesWrapper }
    );

describe("ShareDialog", () => {
    it("draws you first, the rows with a total, and General access", async () => {
        open();
        expect(await screen.findByText("Maria (you)")).toBeTruthy();
        expect(screen.getByText("maria@example.test")).toBeTruthy();
        expect(await screen.findByText("Ana")).toBeTruthy();
        expect(screen.getByText("@luis")).toBeTruthy();
        expect(screen.getByText(/1,284/)).toBeTruthy();
        expect(screen.getByText("General access")).toBeTruthy();
        expect(screen.getByText("Restricted")).toBeTruthy();
        expect(screen.getByRole("button", { name: /Copy link/ })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
        expect(screen.getByRole("combobox", { name: "Add people, teams or roles" })).toBeTruthy();
    });

    const pick = async (menuName: string, optionName: string) => {
        const menu = screen.getByRole("combobox", { name: menuName });
        await act(async () => {
            menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
        const option = await screen.findByRole("option", { name: optionName });
        await act(async () => option.click());
    };

    it("takes a row out at once and puts it back when the server refuses", async () => {
        let answer: (value: { error: string }) => void = () => {};
        actions.revokeShareAction.mockReturnValue(new Promise((done) => (answer = done)));
        open();
        await screen.findByText("Ana");
        await pick("Access for Ana", "Remove access");
        await waitFor(() => expect(actions.revokeShareAction).toHaveBeenCalled());
        expect(screen.queryByText("Ana")).toBeNull();
        await act(async () => answer({ error: "No" }));
        expect(await screen.findByText("Ana")).toBeTruthy();
    });

    it("changes a role at once and puts it back when the server refuses", async () => {
        let answer: (value: { error: string }) => void = () => {};
        actions.updateShareAction.mockReturnValue(new Promise((done) => (answer = done)));
        open();
        await screen.findByText("Ana");
        await pick("Access for Ana", "Admin");
        await waitFor(() => expect(actions.updateShareAction).toHaveBeenCalled());
        expect(actions.updateShareAction.mock.calls[0]?.[3]).toMatchObject({ capability: "admin" });
        expect(screen.getByRole("combobox", { name: "Access for Ana" }).textContent).toContain("Admin");
        await act(async () => answer({ error: "No" }));
        await waitFor(() =>
            expect(screen.getByRole("combobox", { name: "Access for Ana" }).textContent).not.toContain("Admin")
        );
    });

    it("fits a phone: rows and names truncate instead of overflowing", async () => {
        Object.defineProperty(window, "innerWidth", { value: 360, configurable: true });
        open();
        const name = await screen.findByText("Ana");
        expect(name.className).toContain("truncate");
        expect(name.parentElement?.className).toContain("min-w-0");
        const title = screen.getByText(/Share Indoor Studio/);
        expect(title.className).toContain("truncate");
    });
});
