// @vitest-environment jsdom

/**
 * The Registries screen as its two readers see it: somebody who manages the
 * shelf gets the actions, an organization member only the list. The form
 * checks as it is typed with the schema the server applies. Server actions are
 * stand-ins.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RegistriesView } from "@/app/(app)/apps/deploy/registries/registries-view";
import { RegistryDialog } from "@/app/(app)/apps/deploy/registries/registry-dialog";

const listRegistriesAction = vi.fn();

vi.mock("@/app/(app)/apps/deploy/registry-actions", () => ({
    listRegistriesAction: () => listRegistriesAction(),
    createRegistryAction: vi.fn(async () => ({ error: "nope" })),
    updateRegistryAction: vi.fn(async () => ({ error: "nope" })),
    deleteRegistryAction: vi.fn(async () => ({})),
    testRegistryAction: vi.fn(async () => ({ result: "ok" }))
}));

const REGISTRY = {
    id: "r1",
    name: "Company images",
    kind: "ghcr" as const,
    registry: "ghcr.io",
    username: "octo",
    orgId: "org-1",
    updatedAt: new Date(0).toISOString(),
    lastTestedAt: null,
    lastTestOk: null
};

afterEach(() => {
    cleanup();
    listRegistriesAction.mockReset();
    try {
        localStorage.clear();
    } catch {
        // Nothing cached to clear.
    }
});

describe("the Registries screen", () => {
    it("gives a manager the row actions", async () => {
        listRegistriesAction.mockResolvedValue({
            registries: [REGISTRY],
            canManage: true,
            orgId: "org-1"
        });
        render(<RegistriesView />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Company images")).toBeDefined();
        expect(screen.getByText("ghcr.io - octo")).toBeDefined();
        expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();
        expect(screen.getByRole("button", { name: "Test connection" })).toBeDefined();
        expect(
            (screen.getByRole("button", { name: /Add registry/ }) as HTMLButtonElement).disabled
        ).toBe(false);
    });

    it("shows a member the list without actions, and says why", async () => {
        listRegistriesAction.mockResolvedValue({
            registries: [REGISTRY],
            canManage: false,
            orgId: "org-1"
        });
        render(<RegistriesView />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Company images")).toBeDefined();
        expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
        expect(
            (screen.getByRole("button", { name: /Add registry/ }) as HTMLButtonElement).disabled
        ).toBe(true);
        expect(
            screen.getAllByText("Only an organization admin can add or change these logins.").length
        ).toBeGreaterThan(0);
    });
});

describe("the registry form", () => {
    it("keeps Save off until the form passes, and flags a bad field as it is typed", () => {
        render(
            <RegistryDialog registry={null} onClose={() => undefined} onSaved={() => undefined} />,
            {
                wrapper: MessagesWrapper
            }
        );
        const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        // Nothing typed yet is unfinished, not wrong.
        expect(screen.queryByText("Enter the username.")).toBeNull();

        const [, , username, secret] = screen
            .getAllByRole("textbox")
            .concat(
                Array.from(document.querySelectorAll<HTMLInputElement>("input[type=password]"))
            );
        fireEvent.change(username!, { target: { value: "has space" } });
        expect(screen.getByText("A username has no spaces or colons.")).toBeDefined();
        fireEvent.change(username!, { target: { value: "hubuser" } });
        fireEvent.change(secret!, { target: { value: "token" } });
        expect(save.disabled).toBe(false);
    });

    it("lets an edit keep the stored secret", () => {
        render(
            <RegistryDialog
                registry={REGISTRY}
                onClose={() => undefined}
                onSaved={() => undefined}
            />,
            {
                wrapper: MessagesWrapper
            }
        );
        expect(screen.getByText("Leave empty to keep the saved one.")).toBeDefined();
        expect(document.querySelector<HTMLInputElement>("input[type=password]")!.value).toBe("");
    });
});
