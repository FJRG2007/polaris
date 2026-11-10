/**
 * The people a Tasks picker offers are the people the space was handed to in
 * the share dialog: named directly, on a team named, or holding a role named -
 * on the space or on a folder inside it. Read from AccessGrant, never from the
 * older membership tables.
 */

import { describe, expect, it, vi } from "vitest";

const grantQuery = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        taskSpace: {
            findUnique: async () => ({ owner: { id: "owner", name: "Olga" } })
        },
        taskFolder: { findMany: async () => [{ id: "f1" }] },
        accessGrant: {
            findMany: async (args: unknown) => {
                grantQuery(args);
                return [
                    { principalType: "user", principalId: "ana" },
                    { principalType: "team", principalId: "team-1" },
                    { principalType: "role", principalId: "role-1" },
                    // The owner shared again by name is still listed once.
                    { principalType: "user", principalId: "owner" }
                ];
            }
        },
        teamMember: { findMany: async () => [{ userId: "bo" }, { userId: "ana" }] },
        orgRole: { findMany: async () => [{ orgId: "org-1", slug: "support" }] },
        organizationMember: { findMany: async () => [{ userId: "cy" }] },
        user: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map((id) => ({ id, name: id.toUpperCase() }))
        },
        taskSpaceMember: { findMany: vi.fn() },
        taskFolderMember: { findMany: vi.fn() },
        taskSpaceTeam: { findMany: vi.fn() },
        taskFolderTeam: { findMany: vi.fn() }
    }
}));

const { spacePeople } = await import("@/lib/tasks/space-service");

describe("spacePeople", () => {
    it("lists the owner, people, team members and role holders given access by grant", async () => {
        const people = await spacePeople("s1");
        expect(people.map((person) => person.id)).toEqual(["owner", "ana", "bo", "cy"]);
        expect(people[0]).toEqual({ id: "owner", name: "Olga" });
    });

    it("asks for the grants on the space and on every folder inside it", async () => {
        await spacePeople("s1");
        const { where } = grantQuery.mock.calls.at(-1)![0] as {
            where: { OR: { subjectType: string; subjectId: unknown }[] };
        };
        expect(where.OR).toEqual([
            { subjectType: "task.space", subjectId: { in: ["s1"] } },
            { subjectType: "task.folder", subjectId: { in: ["f1"] } }
        ]);
    });
});
