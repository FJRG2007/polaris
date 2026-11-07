// @vitest-environment jsdom

/**
 * The projects Polaris runs for itself, out of Deploy.
 *
 * The report: Deploy was full of the Marketplace project and Polaris's own
 * services, burying what people deployed, behind a switch that only hid them.
 * Deploy now lists only what people deployed; those projects stay exactly as
 * they are and their addresses lead to the app that runs them.
 */

import { MessagesWrapper } from "../setup/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    projects: [] as Array<{
        id: string;
        slug: string;
        applications: string[];
        databases: number;
    }>,
    installs: [] as Array<{ applicationId: string | null; catalogId: string; status?: string }>,
    mail: [] as Array<{ applicationId: string | null }>,
    applications: [] as Array<{ id: string; projectId: string }>
}));

vi.mock("@polaris/db", () => {
    const inIds = (where: { applicationId?: { in?: string[] } } | undefined) => {
        const ids = where?.applicationId?.in;
        return (row: { applicationId: string | null }) =>
            row.applicationId !== null && (!ids || ids.includes(row.applicationId));
    };
    return {
        prisma: {
            project: {
                findMany: async ({ where }: { where: Record<string, unknown> }) => {
                    if (typeof where.slug === "string") {
                        return db.projects
                            .filter((project) => project.slug === where.slug)
                            .map(({ id }) => ({ id }));
                    }
                    const skip = (where.slug as { not: string } | undefined)?.not;
                    const managed = (
                        where.environments as {
                            some: { applications: { some: { id: { in: string[] } } } };
                        }
                    ).some.applications.some.id.in;
                    return db.projects
                        .filter((project) => project.slug !== skip)
                        .filter((project) =>
                            project.applications.some((id) => managed.includes(id))
                        )
                        .map((project) => ({
                            id: project.id,
                            slug: project.slug,
                            environments: [
                                {
                                    applications: project.applications.map((id) => ({ id })),
                                    databases: Array.from(
                                        { length: project.databases },
                                        (_, i) => ({
                                            id: `db${i}`
                                        })
                                    )
                                }
                            ]
                        }));
                }
            },
            installedApp: {
                findMany: async ({
                    where
                }: {
                    where?: { applicationId?: { in?: string[] }; status?: { not: string } };
                }) =>
                    db.installs
                        .filter(inIds(where))
                        .filter((row) => !where?.status || row.status !== where.status.not)
            },
            mailServer: {
                findMany: async ({ where }: { where?: { applicationId?: { in?: string[] } } }) =>
                    db.mail.filter(inIds(where))
            },
            application: {
                findMany: async ({
                    where
                }: {
                    where: { environment: { projectId: string }; id?: string };
                }) =>
                    db.applications
                        .filter((app) => app.projectId === where.environment.projectId)
                        .filter((app) => !where.id || app.id === where.id)
                        .map(({ id }) => ({ id }))
            }
        }
    };
});
vi.mock("@/lib/session", () => ({}));
vi.mock("@/lib/auth", () => ({}));
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

const { ProjectsGrid } = await import("@/app/(app)/apps/deploy/projects-grid");
const { isManagedProject, MARKETPLACE_PROJECT_SLUG, polarisProjectIds, polarisProjectRedirect } =
    await import("@/lib/deploy/managed-projects");

beforeEach(() => {
    db.projects = [];
    db.installs = [];
    db.mail = [];
    db.applications = [];
});
afterEach(cleanup);

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
            isManagedProject(
                { slug: "mail-mx", applicationIds: ["mail-app"], databaseCount: 0 },
                managed
            )
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
            isManagedProject(
                { slug: "mail-mx", applicationIds: ["mail-app"], databaseCount: 1 },
                managed
            )
        ).toBe(false);
        expect(
            isManagedProject({ slug: "empty", applicationIds: [], databaseCount: 0 }, managed)
        ).toBe(false);
        // A name is not evidence: only what backs the services is.
        expect(
            isManagedProject(
                { slug: "polaris", applicationIds: ["mine"], databaseCount: 0 },
                managed
            )
        ).toBe(false);
    });
});

describe("the projects every Deploy listing leaves out", () => {
    it("hides every Marketplace project and a project of only Polaris's services, and nothing else", async () => {
        db.projects = [
            {
                id: "market-ada",
                slug: MARKETPLACE_PROJECT_SLUG,
                applications: ["vpn-app"],
                databases: 0
            },
            { id: "market-bob", slug: MARKETPLACE_PROJECT_SLUG, applications: [], databases: 0 },
            { id: "mail", slug: "mail-mx", applications: ["mail-app"], databases: 0 },
            { id: "mixed", slug: "shop", applications: ["mail-app", "shop-app"], databases: 0 },
            { id: "site", slug: "site", applications: ["site-app"], databases: 0 }
        ];
        db.installs = [{ applicationId: "vpn-app", catalogId: "vpn-engine" }];
        db.mail = [{ applicationId: "mail-app" }];

        const hidden = await polarisProjectIds();

        expect([...hidden].sort()).toEqual(["mail", "market-ada", "market-bob"]);
    });

    it("gives back a project whose install was removed", async () => {
        db.projects = [{ id: "old", slug: "old-world", applications: ["old-app"], databases: 0 }];
        db.installs = [{ applicationId: "old-app", catalogId: "minecraft", status: "removed" }];
        expect([...(await polarisProjectIds())]).toEqual([]);
    });

    it("hides only the Marketplace projects when Polaris set up no service elsewhere", async () => {
        db.projects = [
            { id: "market", slug: MARKETPLACE_PROJECT_SLUG, applications: [], databases: 0 },
            { id: "site", slug: "site", applications: ["site-app"], databases: 0 }
        ];
        expect([...(await polarisProjectIds())]).toEqual(["market"]);
    });
});

const VPN_APP = "00000000-0000-4000-8000-000000000001";
const MC_APP = "00000000-0000-4000-8000-000000000002";
const SITE_APP = "00000000-0000-4000-8000-000000000003";

describe("an address into one of those projects", () => {
    beforeEach(() => {
        db.projects = [
            {
                id: "market",
                slug: MARKETPLACE_PROJECT_SLUG,
                applications: [VPN_APP, MC_APP],
                databases: 0
            },
            { id: "site", slug: "site", applications: [SITE_APP], databases: 0 }
        ];
        db.installs = [
            { applicationId: VPN_APP, catalogId: "vpn-engine" },
            { applicationId: MC_APP, catalogId: "minecraft" }
        ];
        db.applications = [
            { id: VPN_APP, projectId: "market" },
            { id: MC_APP, projectId: "market" },
            { id: SITE_APP, projectId: "site" }
        ];
    });

    it("goes to the settings of the app that runs the service it names", async () => {
        expect(await polarisProjectRedirect("market", VPN_APP)).toBe("/admin/apps/vpn/settings");
        expect(await polarisProjectRedirect("market", MC_APP)).toBe(
            "/admin/apps/game-servers/settings"
        );
    });

    it("goes to the Polaris apps list when the project holds more than one app", async () => {
        expect(await polarisProjectRedirect("market")).toBe("/admin/apps");
    });

    it("ignores a service id that is not one, rather than failing", async () => {
        expect(await polarisProjectRedirect("market", "abc")).toBe("/admin/apps");
    });

    it("leaves a project somebody deployed exactly as it was", async () => {
        expect(await polarisProjectRedirect("site", SITE_APP)).toBeNull();
    });
});

const card = (id: string, name: string) => ({
    id,
    name,
    environmentName: "production",
    services: [],
    online: 0,
    deploying: 0,
    total: 0,
    tags: [] as string[],
    serviceTags: [] as string[]
});

describe("the Deploy list", () => {
    it("shows the projects it is given and no switch for Polaris's own", () => {
        render(
            <MessagesWrapper>
                <ProjectsGrid
                    projects={[card("p1", "Website"), card("p2", "Shop")]}
                    canManage={false}
                    localReady
                />
            </MessagesWrapper>
        );
        expect(screen.getByText("Website")).toBeTruthy();
        expect(screen.getByText("Shop")).toBeTruthy();
        expect(screen.queryByRole("switch")).toBeNull();
        expect(screen.queryByText(/apps Polaris runs/)).toBeNull();
    });
});
