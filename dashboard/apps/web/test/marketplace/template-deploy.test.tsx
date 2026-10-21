// @vitest-environment jsdom

/**
 * Deploying a template from the marketplace is Deploy's own template flow: the
 * card's Deploy asks which project it goes into, then Deploy's template form -
 * opened on that template - creates the service with Deploy's own action.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const push = vi.hoisted(() => vi.fn());
const deploy = vi.hoisted(() => ({
    listTemplateTargetsAction: vi.fn(async () => [
        {
            id: "project-1",
            name: "Website",
            environments: [{ id: "env-1", name: "production", isDefault: true }]
        }
    ]),
    listDeployServersAction: vi.fn(async () => [
        { id: "local", name: "This server", kind: "local" as const }
    ]),
    createApplicationAction: vi.fn(async () => ({}))
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push, refresh: vi.fn() }),
    usePathname: () => "/apps/marketplace",
    useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/app/(app)/apps/deploy/actions", () => deploy);
vi.mock("@/app/(app)/apps/marketplace/actions", () => ({
    installAppAction: vi.fn(),
    listInstallTargetsAction: vi.fn(async () => []),
    listStorageConnectionsAction: vi.fn(async () => [])
}));
vi.mock("@/app/(app)/apps/installed/[id]/actions", () => ({
    uninstallInstalledAppAction: vi.fn()
}));

afterEach(cleanup);

/** The card whose name links to this entry's page. */
function cardOf(name: string): HTMLElement {
    const shelf = screen.getByRole("region", { name: "From other developers" });
    return within(shelf).getByRole("link", { name }).closest("article") as HTMLElement;
}

describe("deploying a template from the marketplace", () => {
    it("picks the project, then creates the service through Deploy's template flow", async () => {
        render(<MarketplaceView installed={[]} canInstall />, { wrapper: MessagesWrapper });
        fireEvent.click(within(cardOf("n8n")).getByRole("button", { name: "Deploy" }));

        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("Deploy n8n")).toBeTruthy();
        fireEvent.click(await within(dialog).findByRole("button", { name: "Continue" }));

        // Deploy's own form, already on the template, with the name it suggests.
        const name = await within(dialog).findByDisplayValue("n8n");
        expect(name).toBeTruthy();
        await waitFor(() => expect(deploy.listDeployServersAction).toHaveBeenCalledWith("env-1"));
        fireEvent.click(within(dialog).getByRole("button", { name: /^\s*Deploy\s*$/ }));

        await waitFor(() =>
            expect(deploy.createApplicationAction).toHaveBeenCalledWith({
                environmentId: "env-1",
                name: "n8n",
                templateId: "n8n",
                serverId: "local"
            })
        );
        await waitFor(() => expect(push).toHaveBeenCalledWith("/apps/deploy/project-1"));
    });

    it("says what to do when there is no project to deploy into", async () => {
        deploy.listTemplateTargetsAction.mockResolvedValueOnce([]);
        render(<MarketplaceView installed={[]} canInstall />, { wrapper: MessagesWrapper });
        fireEvent.click(within(cardOf("n8n")).getByRole("button", { name: "Deploy" }));
        const dialog = await screen.findByRole("dialog");
        const create = await within(dialog).findByRole("link", { name: "Create a project" });
        expect(create.getAttribute("href")).toBe("/apps/deploy");
        expect(deploy.createApplicationAction).toHaveBeenCalledTimes(1);
    });
});
