/**
 * Consumption by app, now that Polaris's own services left Deploy.
 *
 * The report: the machine's usage read the VPN's control server and the mail
 * server as "Deployed services" under a "Marketplace / production" project, with
 * a link into Deploy. They are each an app's: listed under Apps by that app,
 * opening at the app, never at a Deploy project nobody can see any more.
 */

import { subjectHash } from "@/lib/consumption";
import { describe, expect, it, vi } from "vitest";

const VPN = "0198f4c1-2b7a-7000-8000-000000000001";
const MAIL = "0198f4c1-2b7a-7000-8000-000000000002";
const SITE = "0198f4c1-2b7a-7000-8000-000000000003";
const ORPHAN = "0198f4c1-2b7a-7000-8000-000000000004";

const inProject = (id: string, name: string, projectId: string, projectName: string) => ({
    id,
    name,
    environment: {
        name: "production",
        projectId,
        project: { name: projectName, ownerId: "ada" }
    }
});

vi.mock("@polaris/db", () => ({
    prisma: {
        application: {
            findMany: async () => [
                inProject(VPN, "vpn-engine", "market", "Marketplace"),
                inProject(ORPHAN, "left-over", "market", "Marketplace"),
                inProject(MAIL, "mail-mx", "mail", "Mail mx"),
                inProject(SITE, "website", "site", "Website")
            ]
        },
        managedDatabase: { findMany: async () => [] },
        installedApp: {
            findMany: async () => [
                {
                    id: "install-vpn",
                    name: "VPN control server",
                    catalogId: "vpn-engine",
                    applicationId: VPN,
                    ownerId: "ada"
                },
                {
                    id: "install-vpn-app",
                    name: "VPN",
                    catalogId: "vpn",
                    applicationId: null,
                    ownerId: "ada"
                }
            ]
        },
        mailServer: { findMany: async () => [{ applicationId: MAIL }] },
        user: { findMany: async () => [{ id: "ada", name: "Ada" }] }
    }
}));
vi.mock("@/lib/deploy-service", () => ({
    visibleProjectIds: async () => new Set(["market", "mail", "site"])
}));
vi.mock("@/lib/deploy/managed-projects", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/deploy/managed-projects")>()),
    polarisProjectIds: async () => new Set(["market", "mail"])
}));
vi.mock("@/lib/docker-service", () => ({
    LOCAL_DOCKER_CONNECTION_ID: "local",
    localDockerDriver: () => ({
        listContainers: async () =>
            [VPN, MAIL, SITE, ORPHAN].map((id) => ({
                id: `c-${id}`,
                name: `c-${id}`,
                image: "image",
                state: "running",
                composeProject: `polaris-${subjectHash(id)}`,
                composeService: "app"
            })),
        info: async () => ({ name: "lirio", ncpu: 4, memTotal: 1 }),
        dispose: async () => undefined
    })
}));
vi.mock("@/lib/container-stats-cache", () => ({
    STATS_TTL_MS: 60_000,
    cachedSamples: () => new Map(),
    oldestSampleAt: () => Date.now(),
    refreshSamples: () => undefined
}));

const { readConsumption } = await import("@/lib/consumption-service");

async function rows() {
    const { groups } = await readConsumption("ada");
    return groups.flatMap((group) =>
        group.rows.map((row) => ({
            group: group.id,
            name: row.name,
            detail: row.detail,
            href: row.href
        }))
    );
}

describe("what Polaris runs for its apps, on the consumption screen", () => {
    it("lists the VPN's service under the VPN app, not under a Deploy project", async () => {
        const vpn = (await rows()).find((row) => row.name === "VPN");
        expect(vpn?.group).toBe("apps");
        expect(vpn?.href ?? "").not.toContain("/apps/deploy/");
    });

    it("lists the mail server under its app and opens at its settings", async () => {
        const mail = (await rows()).find((row) => row.href === "/admin/apps/mail-server/settings");
        expect(mail?.group).toBe("apps");
    });

    it("keeps a service left in the Marketplace project out of Deploy's rows", async () => {
        const all = await rows();
        const orphan = all.find((row) => row.name === "left-over");
        expect(orphan?.group).toBe("apps");
        expect(orphan?.href).toBeNull();
        expect(all.some((row) => row.detail.includes("Marketplace"))).toBe(false);
    });

    it("leaves what somebody deployed under Deployed services, linked into Deploy", async () => {
        const site = (await rows()).find((row) => row.name === "website");
        expect(site?.group).toBe("services");
        expect(site?.href).toBe(`/apps/deploy/site?service=${SITE}`);
    });
});
