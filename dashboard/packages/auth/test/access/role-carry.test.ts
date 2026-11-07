/**
 * Seeding the built-in roles on an install that already has them.
 *
 * Seeding never rewrites a stored role, so a grant added to a default role only
 * reaches existing installs through a one-time carry. `family.manage` is carried
 * to the `member` role alone, and the carries run once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type RoleRow = { id: string; name: string; permissions: string };
let roles: RoleRow[] = [];
let settings = new Map<string, string>();

vi.mock("@polaris/db", () => ({
    prisma: {
        role: {
            upsert: async ({ where }: { where: { name: string } }) =>
                roles.find((role) => role.name === where.name),
            findMany: async () => roles.map((role) => ({ ...role })),
            update: async ({
                where,
                data
            }: {
                where: { id: string };
                data: { permissions: string };
            }) => {
                const role = roles.find((entry) => entry.id === where.id);
                if (role) role.permissions = data.permissions;
                return role;
            }
        },
        setting: {
            findUnique: async ({ where }: { where: { key: string } }) =>
                settings.has(where.key) ? { key: where.key } : null,
            upsert: async ({
                where,
                create
            }: {
                where: { key: string };
                create: { value: string };
            }) => {
                if (!settings.has(where.key)) settings.set(where.key, create.value);
                return { key: where.key };
            }
        }
    }
}));

vi.mock("../../src/authz.js", () => ({ can: vi.fn() }));

const { seedDefaultRoles } = await import("../../src/roles.js");

function grants(name: string): string[] {
    const role = roles.find((entry) => entry.name === name);
    return role ? (JSON.parse(role.permissions) as string[]) : [];
}

describe("seedDefaultRoles on an existing install", () => {
    beforeEach(() => {
        settings = new Map();
        roles = [
            { id: "r-admin", name: "admin", permissions: JSON.stringify(["*"]) },
            { id: "r-member", name: "member", permissions: JSON.stringify(["chat.use"]) },
            { id: "r-viewer", name: "viewer", permissions: JSON.stringify(["chat.use"]) },
            { id: "r-guest", name: "guest", permissions: JSON.stringify([]) },
            { id: "r-custom", name: "support", permissions: JSON.stringify(["chat.use"]) }
        ];
    });

    it("gives family.manage to the stored member role", async () => {
        await seedDefaultRoles();
        expect(grants("member")).toContain("family.manage");
    });

    it("gives it to no other role", async () => {
        await seedDefaultRoles();
        expect(grants("viewer")).not.toContain("family.manage");
        expect(grants("guest")).not.toContain("family.manage");
        expect(grants("support")).not.toContain("family.manage");
        expect(grants("admin")).toEqual(["*"]);
    });

    it("keeps carrying the chat grants to roles that hold the chat", async () => {
        await seedDefaultRoles();
        expect(grants("viewer")).toContain("chat.attach");
        expect(grants("guest")).toEqual([]);
    });

    it("carries once, so an operator who removes it keeps it removed", async () => {
        await seedDefaultRoles();
        const member = roles.find((role) => role.name === "member")!;
        member.permissions = JSON.stringify(
            grants("member").filter((grant) => grant !== "family.manage")
        );
        await seedDefaultRoles();
        expect(grants("member")).not.toContain("family.manage");
    });
});
