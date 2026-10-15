// @vitest-environment jsdom

/**
 * The linked groups on a service: the groups it reads, the order its variables
 * resolve in and where each value came from, a secret shown as hidden, and the
 * redeploy offered once a link changes on a running service. And the projects
 * list narrowed to a tag.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
    serviceVariableGroupsAction: vi.fn(),
    unlinkVariableGroupAction: vi.fn(),
    linkVariableGroupAction: vi.fn(),
    redeployEnvScopeAction: vi.fn()
}));

vi.mock("@/lib/session", () => ({}));
vi.mock("@/lib/auth", () => ({}));
vi.mock("@/app/(app)/apps/deploy/variable-group-actions", () => ({
    serviceVariableGroupsAction: mocks.serviceVariableGroupsAction,
    unlinkVariableGroupAction: mocks.unlinkVariableGroupAction,
    linkVariableGroupAction: mocks.linkVariableGroupAction
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: () => undefined, push: () => undefined })
}));
vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    createProjectAction: async () => ({}),
    deleteProjectAction: async () => ({})
}));
vi.mock("@/app/(app)/apps/deploy/registry-credentials", () => ({
    RegistryCredentialsButton: () => null
}));
vi.mock("@/app/(app)/apps/deploy/variable-actions", () => ({
    redeployEnvScopeAction: mocks.redeployEnvScopeAction
}));

const { LinkedGroupsPanel } = await import("@/app/(app)/apps/deploy/variable-groups");
const { filterByTag, ProjectsGrid } = await import("@/app/(app)/apps/deploy/projects-grid");

const VIEW = {
    linked: [
        {
            id: "g-1",
            name: "Payments",
            position: 0,
            keys: [{ key: "STRIPE_KEY", isSecret: true }, { key: "REGION", isSecret: false }],
            canEdit: false
        }
    ],
    linkable: [{ id: "g-2", name: "Database" }],
    resolved: [
        {
            key: "REGION",
            value: "eu",
            isSecret: false,
            source: { kind: "service" },
            overridden: [{ kind: "group", id: "g-1", name: "Payments" }]
        },
        {
            key: "STRIPE_KEY",
            value: null,
            isSecret: true,
            source: { kind: "group", id: "g-1", name: "Payments" },
            overridden: []
        }
    ],
    canLink: true,
    deployed: true
};

function show() {
    return render(
        <MessagesWrapper>
            <LinkedGroupsPanel applicationId="app-1" canDeploy />
        </MessagesWrapper>
    );
}

beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.serviceVariableGroupsAction.mockResolvedValue(VIEW);
});
afterEach(cleanup);

describe("LinkedGroupsPanel", () => {
    it("lists the linked groups and where each resolved value came from", async () => {
        show();
        expect(await screen.findByText("REGION")).toBeTruthy();
        expect(screen.getAllByText("Payments").length).toBeGreaterThan(0);
        expect(screen.getByText("STRIPE_KEY")).toBeTruthy();
        // The secret's value never reaches the screen; nothing here holds it.
        expect(document.body.textContent).not.toContain("sk_");
        expect(mocks.serviceVariableGroupsAction).toHaveBeenCalledWith({ applicationId: "app-1" });
    });

    it("offers a redeploy once a link changes on a running service", async () => {
        mocks.unlinkVariableGroupAction.mockResolvedValue({});
        mocks.redeployEnvScopeAction.mockResolvedValue({});
        show();
        await userEvent.click(await screen.findByRole("button", { name: /Payments/ }));
        expect(mocks.unlinkVariableGroupAction).toHaveBeenCalledWith({ applicationId: "app-1", groupId: "g-1" });
        const redeploy = await screen.findByRole("button", { name: /redeploy/i });
        await userEvent.click(redeploy);
        await waitFor(() =>
            expect(mocks.redeployEnvScopeAction).toHaveBeenCalledWith({ scope: "application", scopeId: "app-1" })
        );
    });

    it("says what went wrong when the service's groups cannot be read", async () => {
        mocks.serviceVariableGroupsAction.mockResolvedValue({ error: "That variable group is not there any more." });
        show();
        expect(await screen.findByText("That variable group is not there any more.")).toBeTruthy();
    });
});

describe("filterByTag", () => {
    const projects = [
        { id: "a", tags: ["production", "eu"] },
        { id: "b", tags: ["staging"] },
        { id: "c", tags: [] }
    ];

    it("keeps every project when no tag is picked", () => {
        expect(filterByTag(projects, null).map((one) => one.id)).toEqual(["a", "b", "c"]);
    });

    it("keeps only the projects carrying the tag", () => {
        expect(filterByTag(projects, "production").map((one) => one.id)).toEqual(["a"]);
        expect(filterByTag(projects, "missing")).toEqual([]);
    });

    it("finds a project by a tag on one of its services", () => {
        const withServices = [
            { id: "a", tags: [], serviceTags: ["payments"] },
            { id: "b", tags: ["payments"], serviceTags: [] },
            { id: "c", tags: [], serviceTags: [] }
        ];
        expect(filterByTag(withServices, "payments").map((one) => one.id)).toEqual(["a", "b"]);
    });
});

describe("the projects list", () => {
    const card = (id: string, name: string, tags: string[]) => ({
        id,
        name,
        managed: false,
        environmentName: "production",
        services: [],
        online: 0,
        deploying: 0,
        total: 0,
        tags,
        serviceTags: [] as string[]
    });

    it("narrows to the projects carrying the tag picked", async () => {
        render(
            <MessagesWrapper>
                <ProjectsGrid
                    projects={[card("p1", "Website", ["production"]), card("p2", "Sandbox", ["staging"])]}
                    canManage={false}
                    localReady
                    viewerId="ada"
                    hideManagedByDefault={false}
                />
            </MessagesWrapper>
        );
        expect(screen.getByText("Website")).toBeTruthy();
        expect(screen.getByText("Sandbox")).toBeTruthy();
        await userEvent.click(screen.getByRole("button", { name: "Filter by tag" }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "staging" }));
        await waitFor(() => expect(screen.queryByText("Website")).toBeNull());
        expect(screen.getByText("Sandbox")).toBeTruthy();
    });
});
