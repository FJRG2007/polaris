/**
 * Deploy alerts are filed on the shelf their project is on.
 *
 * Deploy lists a company's projects on that company's shelf only, so a failed
 * deploy of one is counted on that shelf's bell. And a sweep that moved domains
 * on two shelves says so once per shelf rather than once for both, since no one
 * shelf lists everything it would name.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Projects by id: which organization owns each, null for somebody's own. */
const projects: Record<string, { name: string; orgId: string | null }> = {
    shop: { name: "Shop", orgId: "acme" },
    blog: { name: "Blog", orgId: null }
};
const sent: Array<{ userId: string; event: string; shelf?: { orgId: string | null }; metadata?: unknown }> = [];

function project(id: string) {
    return { id, name: projects[id]!.name, ownerId: "owner", orgId: projects[id]!.orgId };
}

vi.mock("@polaris/db", () => ({
    prisma: {
        deployment: {
            findUnique: async () => ({
                deployableType: "application",
                deployableId: "app-shop",
                error: "exit 1",
                commitSha: null,
                triggeredById: null
            })
        },
        application: {
            findUnique: async () => ({ name: "web", environment: { project: project("shop") } })
        },
        domain: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map((id) => {
                    const owner = id.startsWith("shop") ? "shop" : "blog";
                    return {
                        id,
                        hostname: `${id}.example.test`,
                        application: { id: `app-${owner}`, name: "web", environment: { project: project(owner) } }
                    };
                })
        },
        projectMember: { findMany: async () => [] }
    }
}));
vi.mock("@/lib/follow/follow", () => ({ followers: async () => [] }));
vi.mock("@/lib/deploy-project-service", () => ({ dispatchProjectWebhooks: async () => undefined }));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (input: (typeof sent)[number]) => {
        sent.push(input);
    }
}));

const { notifyDeployFinished } = await import("@/lib/notifications/deploy-events");
const { notifyDomainHealthChanges } = await import("@/lib/notifications/domain-events");

beforeEach(() => {
    sent.length = 0;
});

describe("deploy alerts", () => {
    it("files a finished deploy on its project's shelf", async () => {
        await notifyDeployFinished({ deploymentId: "d1", ownerId: "owner", ok: false });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ userId: "owner", event: "deploy.failed", shelf: { orgId: "acme" } });
    });

    it("says a sweep once per shelf, each on its own", async () => {
        await notifyDomainHealthChanges([
            { domainId: "shop-1", status: "down", detail: null },
            { domainId: "shop-2", status: "down", detail: null },
            { domainId: "blog-1", status: "down", detail: null }
        ]);
        const byShelf = new Map(sent.map((alert) => [alert.shelf?.orgId ?? null, alert]));
        expect(sent).toHaveLength(2);
        expect(byShelf.get("acme")?.metadata).toMatchObject({ domainIds: ["shop-1", "shop-2"] });
        expect(byShelf.get(null)?.metadata).toMatchObject({ domainId: "blog-1" });
    });
});
