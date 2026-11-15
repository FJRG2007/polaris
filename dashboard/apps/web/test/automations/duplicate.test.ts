/**
 * Duplicating an automation: a switched-off copy on the same shelf, with the
 * draft and its settings but none of the original's pinned samples, grants or
 * published version - and only for somebody who may edit that shelf.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    row: null as Record<string, unknown> | null,
    created: [] as Record<string, unknown>[],
    count: 0
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        automation: {
            findUnique: async ({ select }: { select: Record<string, boolean> }) =>
                db.row
                    ? Object.fromEntries(Object.keys(select).map((key) => [key, db.row![key]]))
                    : null,
            count: async () => db.count,
            create: async ({ data }: { data: Record<string, unknown> }) => {
                db.created.push(data);
                return { id: "00000000-0000-4000-8000-0000000000c2" };
            }
        }
    }
}));
const access = vi.hoisted(() => ({ edit: true }));
vi.mock("@/lib/automations/runner", () => ({
    automationRunner: async () => ({ id: "u1", isAdmin: false }),
    mayReadShelf: async () => true,
    mayEditShelf: async () => access.edit,
    mayAllowLocalNetwork: async () => false
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/automations/secrets", () => ({ readSecretForRun: async () => "" }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => ({ inapp: "sent" }) }));
vi.mock("@/lib/app-extensions/registry", () => ({ appAutomationNodes: async () => [] }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k".repeat(64) }) }));

const service = await import("@/lib/automations/service");

const owner = { id: "u1", isAdmin: false };
const graph = core.emptyGraph("UTC");
graph.nodes.push({ id: "n1", type: "core.manual", typeVersion: 1, config: {} });

describe("duplicating an automation", () => {
    beforeEach(() => {
        db.created = [];
        db.count = 0;
        access.edit = true;
        db.row = {
            id: "00000000-0000-4000-8000-0000000000c1",
            orgId: null,
            userId: "u1",
            name: "Door alert",
            description: "When the door opens",
            enabled: true,
            draft: {
                ...graph,
                nodes: graph.nodes.map((node) => ({ ...node, pinned: [{ secret: 1 }] }))
            },
            publishedVersionId: "00000000-0000-4000-8000-0000000000v1",
            mode: "queue",
            maxRuns: 3,
            rateLimit: 7,
            allowLocalNetwork: true,
            runAsId: "u9",
            origin: null,
            originRef: null,
            updatedAt: new Date(),
            folderId: "00000000-0000-4000-8000-0000000000f1",
            tags: ["home"]
        };
    });

    it("makes an off, unpublished copy on the same shelf with the settings carried over", async () => {
        const id = await service.duplicateAutomation(
            owner,
            db.row!.id as string,
            (name) => `${name} (copy)`
        );
        expect(id).toBe("00000000-0000-4000-8000-0000000000c2");
        const copy = db.created[0]!;
        expect(copy).toMatchObject({
            orgId: null,
            userId: "u1",
            name: "Door alert (copy)",
            description: "When the door opens",
            folderId: "00000000-0000-4000-8000-0000000000f1",
            tags: ["home"],
            mode: "queue",
            maxRuns: 3,
            rateLimit: 7
        });
        for (const key of ["enabled", "publishedVersionId", "allowLocalNetwork", "runAsId"])
            expect(copy).not.toHaveProperty(key);
        expect(JSON.stringify(copy.draft)).not.toContain("secret");
        expect((copy.draft as { nodes: { id: string }[] }).nodes.map((node) => node.id)).toEqual(["n1"]);
    });

    it("keeps the copy's name within the limit", async () => {
        db.row!.name = "x".repeat(core.AUTOMATION_LIMITS.nameLength);
        await service.duplicateAutomation(owner, db.row!.id as string, (name) => `${name} (copy)`);
        expect((db.created[0]!.name as string).length).toBe(core.AUTOMATION_LIMITS.nameLength);
    });

    it("is refused to somebody who cannot edit that shelf, and at the shelf's limit", async () => {
        access.edit = false;
        await expect(
            service.duplicateAutomation({ id: "u2", isAdmin: false }, db.row!.id as string, String)
        ).rejects.toThrow();
        access.edit = true;
        db.count = 10_000;
        await expect(
            service.duplicateAutomation(owner, db.row!.id as string, String)
        ).rejects.toThrow();
        expect(db.created).toEqual([]);
    });
});
