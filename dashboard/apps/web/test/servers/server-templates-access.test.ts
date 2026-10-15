/**
 * Who may touch a server template, and what a fix refuses before it reaches a
 * server: every action asks for the Servers permission first, an assignment is
 * found only through its owner, and a fix on a server Polaris has no root on
 * is refused without opening SSH.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "owner";
const ID = "8d6c3f1e-2b4a-4c7d-9e0f-1a2b3c4d5e6f";

let allowed = true;
let connection = { username: "deploy", sudo: false };
const ssh = vi.fn();
const updates: unknown[] = [];

class Redirect extends Error {}

vi.mock("@/lib/session", () => ({
    requirePermission: async () => {
        if (!allowed) throw new Redirect("NEXT_REDIRECT");
        return { id: OWNER };
    }
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => {} }));
vi.mock("@/lib/host-service", () => ({
    getHostConnection: async () => ({ address: "198.51.100.7", port: 22, auth: {}, hostKey: null, ...connection })
}));
vi.mock("@polaris/ssh", () => ({
    openSshClient: async (...args: unknown[]) => {
        ssh(...args);
        throw new Error("no network in tests");
    },
    execCommand: async () => ({ code: 0 })
}));
vi.mock("@polaris/db", () => {
    const row = {
        id: "8d6c3f1e-2b4a-4c7d-9e0f-1a2b3c4d5e6f",
        hostId: "host",
        autoFix: false,
        drift: [{ key: "pkg:nginx", code: "packageMissing", name: "nginx", fixable: true }],
        template: { ownerId: "owner", spec: { packages: ["nginx"] } }
    };
    const owns = (where: { host?: { ownerId?: string }; template?: { ownerId?: string } }) =>
        where.host?.ownerId === "owner" && where.template?.ownerId === "owner";
    return {
        Prisma: { DbNull: null, PrismaClientKnownRequestError: class extends Error {} },
        prisma: {
            hostTemplateAssignment: {
                findFirst: async ({ where }: { where: Parameters<typeof owns>[0] }) => (owns(where) ? row : null),
                update: async (args: unknown) => {
                    updates.push(args);
                    return { ...row, status: "unknown", error: null, checkedAt: null, fixedAt: null, templateId: "t", template: { name: "Web" } };
                },
                delete: async () => row
            },
            hostTemplate: { deleteMany: async () => ({ count: 0 }), findMany: async () => [] }
        }
    };
});

const actions = await import("../../src/app/(app)/apps/servers/template-actions");
const service = await import("@/lib/server-templates/service");

beforeEach(() => {
    allowed = true;
    connection = { username: "deploy", sudo: false };
    ssh.mockClear();
    updates.length = 0;
});

describe("without the Servers permission", () => {
    beforeEach(() => {
        allowed = false;
    });

    it.each([
        ["list", () => actions.listTemplatesAction()],
        ["save", () => actions.saveTemplateAction(null, { name: "Web", spec: {} })],
        ["delete", () => actions.deleteTemplateAction(ID)],
        ["assignments", () => actions.hostAssignmentsAction(ID)],
        ["assign", () => actions.assignTemplateAction({ templateId: ID, hostId: ID })],
        ["unassign", () => actions.unassignTemplateAction(ID)],
        ["auto-fix", () => actions.setAutoFixAction(ID, true)],
        ["check", () => actions.checkAssignmentAction(ID)],
        ["fix", () => actions.fixAssignmentAction({ assignmentId: ID })]
    ])("%s is sent away before anything is read or run", async (_, call) => {
        await expect(call()).rejects.toBeInstanceOf(Redirect);
        expect(ssh).not.toHaveBeenCalled();
        expect(updates).toEqual([]);
    });
});

describe("with it", () => {
    it("refuses an id that is not one before touching the database", async () => {
        expect(await actions.fixAssignmentAction({ assignmentId: "1; drop table" })).toEqual({ ok: false, error: "invalid" });
        expect(await actions.deleteTemplateAction("nope")).toEqual({ ok: false, error: "invalid" });
    });

    it("finds another owner's assignment as missing", async () => {
        await expect(service.fixAssignment("someone-else", ID)).rejects.toMatchObject({ code: "notFound" });
        await expect(service.unassignTemplate("someone-else", ID)).rejects.toMatchObject({ code: "notFound" });
    });

    it("refuses a fix without root, and never opens SSH for it", async () => {
        expect(await actions.fixAssignmentAction({ assignmentId: ID })).toEqual({ ok: false, error: "noRoot" });
        expect(ssh).not.toHaveBeenCalled();
    });

    it("refuses a fix for an item the last check did not find wrong", async () => {
        connection = { username: "root", sudo: false };
        expect(await actions.fixAssignmentAction({ assignmentId: ID, keys: ["pkg:other"] })).toEqual({ ok: false, error: "nothingToFix" });
        expect(ssh).not.toHaveBeenCalled();
    });

    it("says the server did not answer when SSH cannot open, as root or through sudo", async () => {
        connection = { username: "deploy", sudo: true };
        expect(await actions.fixAssignmentAction({ assignmentId: ID })).toEqual({ ok: false, error: "unreachable" });
        expect(ssh).toHaveBeenCalledTimes(1);
    });
});
