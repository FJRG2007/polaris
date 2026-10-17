/**
 * Folders and tags on the automations list, against the in-memory database the
 * engine tests use: one shelf's folders never take another shelf's automation,
 * deleting a folder keeps what was in it, and a reader changes nothing.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ current: null as Awaited<ReturnType<typeof import("./fixtures/fake-prisma")["createFakeDb"]>> | null }));
const access = vi.hoisted(() => ({ edit: true }));

vi.mock("@polaris/db", async () => {
    const { createFakeDb: make } = await import("./fixtures/fake-prisma");
    db.current = make();
    return { prisma: db.current.prisma };
});
vi.mock("@/lib/automations/runner", () => ({
    automationRunner: async () => ({ id: "u1", isAdmin: false }),
    mayReadShelf: async () => true,
    mayEditShelf: async () => access.edit,
    mayAllowLocalNetwork: async () => false
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/app-extensions/registry", () => ({ appAutomationNodes: async () => [] }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k".repeat(64) }) }));

const organize = await import("@/lib/automations/organize");
const service = await import("@/lib/automations/service");

const fake = () => db.current!;
const actor = { id: "u1", isAdmin: false };
const mine = { orgId: null, userId: "u1" };
const theirs = { orgId: null, userId: "u2" };

async function seed(userId = "u1") {
    const row = await fake().prisma.automation.create({ data: { name: "Test", draft: core.emptyGraph("UTC"), enabled: false, userId, mode: "single", updatedAt: new Date() } });
    return row.id as string;
}

beforeEach(() => {
    fake().reset();
    access.edit = true;
});

describe("folders", () => {
    it("creates, lists, renames and moves an automation in and out of a folder", async () => {
        const folder = await organize.createFolder(actor, mine, "Billing");
        expect(await organize.listFolders(actor, mine)).toEqual([folder]);
        await organize.renameFolder(actor, folder.id, "Invoices");
        expect((await organize.listFolders(actor, mine))[0]!.name).toBe("Invoices");
        const id = await seed();
        await organize.moveToFolder(actor, id, folder.id);
        expect((await service.listAutomations(actor, mine)).rows[0]!.folderId).toBe(folder.id);
        await organize.moveToFolder(actor, id, null);
        expect((await service.listAutomations(actor, mine)).rows[0]!.folderId).toBeNull();
    });

    it("keeps the automations of a deleted folder, in no folder", async () => {
        const folder = await organize.createFolder(actor, mine, "Old");
        const id = await seed();
        await organize.moveToFolder(actor, id, folder.id);
        await organize.deleteFolder(actor, folder.id);
        expect(await organize.listFolders(actor, mine)).toEqual([]);
        expect((await service.listAutomations(actor, mine)).rows.map((row) => row.folderId)).toEqual([null]);
    });

    it("never puts an automation in another shelf's folder, and refuses a reader", async () => {
        const other = await organize.createFolder(actor, theirs, "Theirs");
        const id = await seed();
        await expect(organize.moveToFolder(actor, id, other.id)).rejects.toMatchObject({ code: "notFound" });
        access.edit = false;
        await expect(organize.createFolder(actor, mine, "Nope")).rejects.toMatchObject({ code: "forbidden" });
        await expect(organize.renameFolder(actor, other.id, "x")).rejects.toMatchObject({ code: "forbidden" });
        await expect(organize.setTags(actor, id, ["a"])).rejects.toMatchObject({ code: "forbidden" });
    });
});

describe("tags", () => {
    it("stores the tags the list shows", async () => {
        const id = await seed();
        await organize.setTags(actor, id, core.automationTagsSchema.parse(["Billing", " billing ", "night"]));
        expect((await service.listAutomations(actor, mine)).rows[0]!.tags).toEqual(["billing", "night"]);
    });
});
