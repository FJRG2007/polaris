// @vitest-environment jsdom

/**
 * The projects Polaris runs for itself, kept out of the administrator's way.
 *
 * The report: in Deploy, the administrator's list was full of the Marketplace
 * project and Polaris's own services, burying the projects they build. Those
 * now start hidden for the administrator, behind a switch that says how many
 * there are, and the choice is remembered for that person.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { isManagedProject, MARKETPLACE_PROJECT_SLUG } from "@/lib/deploy/managed-projects";

vi.mock("@/lib/session", () => ({}));
vi.mock("@/lib/auth", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    createProjectAction: async () => ({}),
    deleteProjectAction: async () => ({})
}));
vi.mock("@/app/(app)/apps/deploy/registry-credentials", () => ({ RegistryCredentialsButton: () => null }));

const { ProjectsGrid } = await import("@/app/(app)/apps/deploy/projects-grid");

describe("which projects are Polaris's own", () => {
    const managed = new Set(["mail-app", "minecraft-app"]);

    it("counts the Marketplace project, whatever is in it", () => {
        expect(
            isManagedProject(
                { slug: MARKETPLACE_PROJECT_SLUG, applicationIds: ["mine"], databaseCount: 1 },
                managed
            )
        ).toBe(true);
    });

    it("counts a project holding only services Polaris installed", () => {
        expect(
            isManagedProject({ slug: "mail-mx", applicationIds: ["mail-app"], databaseCount: 0 }, managed)
        ).toBe(true);
    });

    it("leaves the operator's projects alone, even beside one of Polaris's services", () => {
        expect(
            isManagedProject(
                { slug: "mail-mx", applicationIds: ["mail-app", "mine"], databaseCount: 0 },
                managed
            )
        ).toBe(false);
        expect(
            isManagedProject({ slug: "mail-mx", applicationIds: ["mail-app"], databaseCount: 1 }, managed)
        ).toBe(false);
        expect(isManagedProject({ slug: "empty", applicationIds: [], databaseCount: 0 }, managed)).toBe(
            false
        );
        // A name is not evidence: only what backs the services is.
        expect(
            isManagedProject({ slug: "polaris", applicationIds: ["mine"], databaseCount: 0 }, managed)
        ).toBe(false);
    });
});

const card = (id: string, name: string, managed: boolean) => ({
    id,
    name,
    managed,
    environmentName: "production",
    services: [],
    online: 0,
    deploying: 0,
    total: 0
});

const projects = [card("p1", "Website", false), card("p2", "Marketplace", true), card("p3", "Mail mx", true)];

function grid(hideManagedByDefault: boolean, viewerId = "ada") {
    return render(
        <MessagesWrapper>
            <ProjectsGrid
                projects={projects}
                canManage={false}
                localReady
                viewerId={viewerId}
                hideManagedByDefault={hideManagedByDefault}
            />
        </MessagesWrapper>
    );
}

// One browser's storage, kept for the whole file so a choice outlives a render.
const stored = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
        clear: () => stored.clear()
    }
});

beforeEach(() => stored.clear());
afterEach(cleanup);

describe("the Deploy list", () => {
    it("opens on the administrator's own projects, and says how many are hidden", () => {
        grid(true);
        expect(screen.getByText("Website")).toBeTruthy();
        expect(screen.queryByText("Marketplace")).toBeNull();
        expect(screen.queryByText("Mail mx")).toBeNull();
        expect(screen.getByText("Show 2 apps Polaris runs")).toBeTruthy();
        expect(
            screen.getByRole("switch", { name: "Show apps Polaris runs for itself" }).getAttribute("aria-checked")
        ).toBe("false");
    });

    it("shows them on the switch, and remembers that for the same person", () => {
        grid(true);
        act(() => fireEvent.click(screen.getByRole("switch", { name: "Show apps Polaris runs for itself" })));
        expect(screen.getByText("Marketplace")).toBeTruthy();
        cleanup();

        grid(true);
        expect(screen.getByText("Marketplace")).toBeTruthy();
        cleanup();

        // Somebody else in the same browser has their own answer.
        grid(true, "bob");
        expect(screen.queryByText("Marketplace")).toBeNull();
    });

    it("shows everything to anybody who is not the administrator", () => {
        grid(false);
        expect(screen.getByText("Marketplace")).toBeTruthy();
    });

    it("offers a way to them when they are all there is", () => {
        render(
            <MessagesWrapper>
                <ProjectsGrid
                    projects={[card("p2", "Marketplace", true)]}
                    canManage={false}
                    localReady
                    viewerId="ada"
                    hideManagedByDefault
                />
            </MessagesWrapper>
        );
        act(() => fireEvent.click(screen.getByRole("button", { name: "Show them" })));
        expect(screen.getByText("Marketplace")).toBeTruthy();
    });
});
