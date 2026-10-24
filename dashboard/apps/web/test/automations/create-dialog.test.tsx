// @vitest-environment jsdom

/**
 * A new automation starts blank or from a template: the gallery shows the
 * templates the server says fit, and picking one creates it from that template.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
const createAutomationAction = vi.fn();
const creatableShelvesAction = vi.fn();

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/components/access/share-dialog", () => ({ ShareDialog: () => null }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() })
}));
vi.mock("@/app/(app)/automations/actions", () => ({
    createAutomationAction: (...args: unknown[]) => createAutomationAction(...args),
    creatableShelvesAction: () => creatableShelvesAction()
}));

import { MessagesWrapper } from "../setup/i18n";
import { CreateDialog } from "@/app/(app)/automations/automations-list";

beforeEach(() => {
    globalThis.localStorage?.clear?.();
    push.mockReset();
    createAutomationAction.mockReset().mockResolvedValue({ ok: true, id: "new-id" });
    creatableShelvesAction.mockReset().mockResolvedValue({
        ok: true,
        orgs: [],
        openOrgId: null,
        templates: ["internetBack", "deployFailed"]
    });
});
afterEach(cleanup);

describe("the new automation dialog", () => {
    it("lists the templates that fit and starts from the one picked", async () => {
        render(<CreateDialog onClose={vi.fn()} />, { wrapper: MessagesWrapper });
        fireEvent.click(await screen.findByText("Notify me when a deploy fails"));
        expect(screen.queryByText("Post in chat when a game server crashes")).toBeNull();
        await waitFor(() => expect(push).toHaveBeenCalledWith("/automations/new-id"));
        expect(createAutomationAction).toHaveBeenCalledWith(
            {
                name: "Notify me when a deploy fails",
                description: "",
                orgId: null,
                template: "deployFailed"
            },
            expect.any(String)
        );
    });

    it("starts blank without asking for a name or a shelf", async () => {
        render(<CreateDialog onClose={vi.fn()} />, { wrapper: MessagesWrapper });
        await screen.findByText("Tell me when the internet comes back");
        expect(screen.queryByText("Belongs to")).toBeNull();
        fireEvent.click(screen.getByText("Start blank"));
        await waitFor(() => expect(push).toHaveBeenCalled());
        expect(createAutomationAction.mock.calls[0]![0]).toMatchObject({
            name: "Untitled automation",
            template: undefined
        });
    });

    it("says why when creating fails", async () => {
        createAutomationAction.mockResolvedValue({
            ok: false,
            error: "This shelf has reached its limit."
        });
        render(<CreateDialog onClose={vi.fn()} />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByText("Start blank"));
        expect((await screen.findByRole("alert")).textContent).toContain("reached its limit");
        expect(push).not.toHaveBeenCalled();
    });
});
