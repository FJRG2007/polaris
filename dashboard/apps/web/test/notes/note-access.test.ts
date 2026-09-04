/**
 * Who may reach which writing.
 *
 * The half worth testing is the private shelf, because it is the one promise
 * notes have always made: a note with no notebook is its author's and nobody
 * else's, and an instance administrator is nobody else. Every other way in adds
 * up; that one does not exist.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface SpaceRow {
    ownerId: string;
    visibility: string;
    orgId: string | null;
    members: { role: string }[];
    teamGrants: { role: string }[];
    org: {
        ownerId: string;
        members: { role: string }[];
        roles: { slug: string; permissions: string }[];
    } | null;
}

let space: SpaceRow | null = null;
let note: { id: string; userId: string; spaceId: string | null; folderId: string | null } | null = null;

vi.mock("@polaris/db", () => ({
    prisma: {
        noteSpace: { findUnique: async () => space, findMany: async () => [] },
        note: { findUnique: async () => note },
        noteFolder: { findUnique: async () => null }
    }
}));
vi.mock("@/lib/workspace-scope", () => ({ scopeOrgIdFor: async () => null }));
vi.mock("@/lib/orgs/org-service", () => ({
    administeredOrgIds: async () => [],
    memberOrgIds: async () => []
}));

const access = await import("../../src/lib/notes/access");

const me = { id: "u1", isAdmin: false };
const admin = { id: "root", isAdmin: true };

function shelf(over: Partial<SpaceRow> = {}): SpaceRow {
    return {
        ownerId: "u2",
        visibility: "private",
        orgId: null,
        members: [],
        teamGrants: [],
        org: null,
        ...over
    };
}

beforeEach(() => {
    space = null;
    note = null;
});

describe("a note with no notebook", () => {
    it("is its author's", async () => {
        note = { id: "n1", userId: "u1", spaceId: null, folderId: null };
        await expect(access.requireNote(me, "n1", "member")).resolves.toMatchObject({ noteId: "n1" });
    });

    it("is refused to everybody else, an instance administrator included", async () => {
        note = { id: "n1", userId: "u1", spaceId: null, folderId: null };
        await expect(access.requireNote({ id: "u9", isAdmin: false }, "n1", "guest")).rejects.toThrow(
            access.NoteAccessError
        );
        // The one place in Polaris where isAdmin buys nothing. It is the whole
        // promise the private shelf makes.
        await expect(access.requireNote(admin, "n1", "guest")).rejects.toThrow(access.NoteAccessError);
    });
});

describe("a notebook", () => {
    it("opens for whoever made it", async () => {
        space = shelf({ ownerId: "u1" });
        await expect(access.resolveSpaceRole(me, "s1")).resolves.toBe("owner");
    });

    it("opens for a member, and for a team, and the stronger of the two wins", async () => {
        space = shelf({ members: [{ role: "guest" }], teamGrants: [{ role: "admin" }] });
        await expect(access.resolveSpaceRole(me, "s1")).resolves.toBe("admin");
    });

    it("is shut to somebody with no way in", async () => {
        space = shelf();
        await expect(access.resolveSpaceRole(me, "s1")).resolves.toBeNull();
        await expect(access.requireSpace(me, "s1", "guest")).rejects.toThrow(access.NoteAccessError);
    });

    it("refuses a writer's action to a reader", async () => {
        space = shelf({ members: [{ role: "guest" }] });
        await expect(access.requireSpace(me, "s1", "guest")).resolves.toBe("guest");
        await expect(access.requireSpace(me, "s1", "member")).rejects.toThrow(access.NoteAccessError);
    });

    it("reads an internal one to anybody here, and an organization's to its roster only", async () => {
        space = shelf({ visibility: "internal" });
        await expect(access.resolveSpaceRole(me, "s1")).resolves.toBe("guest");

        space = shelf({
            visibility: "internal",
            orgId: "o1",
            org: { ownerId: "u2", members: [], roles: [] }
        });
        await expect(access.resolveSpaceRole(me, "s1")).resolves.toBeNull();

        space = shelf({
            visibility: "internal",
            orgId: "o1",
            org: { ownerId: "u2", members: [{ role: "member" }], roles: [] }
        });
        await expect(access.resolveSpaceRole(me, "s1")).resolves.toBe("guest");
    });

    it("gives the run of it to whoever runs the organization's spaces", async () => {
        // Read off what the role grants, never off its name: an organization
        // names its own roles, and matching on "admin" would offer a notebook to
        // somebody the open path then refuses.
        space = shelf({
            orgId: "o1",
            org: {
                ownerId: "u2",
                members: [{ role: "leads" }],
                roles: [{ slug: "leads", permissions: JSON.stringify(["spaces.manage"]) }]
            }
        });
        await expect(access.resolveSpaceRole(me, "s1")).resolves.toBe("admin");

        space = shelf({
            orgId: "o1",
            org: {
                ownerId: "u2",
                members: [{ role: "leads" }],
                roles: [{ slug: "leads", permissions: JSON.stringify(["org.read"]) }]
            }
        });
        await expect(access.resolveSpaceRole(me, "s1")).resolves.toBeNull();
    });

    it("does open for an instance administrator, unlike the private shelf", async () => {
        space = shelf();
        await expect(access.resolveSpaceRole(admin, "s1")).resolves.toBe("owner");
    });
});

describe("where something is filed", () => {
    it("refuses a folder that is not on the notebook the caller named", async () => {
        space = shelf({ ownerId: "u1" });
        await expect(
            access.requirePlacement(me, { spaceId: "s1", folderId: "f1" })
        ).rejects.toThrow(access.NoteAccessError);
    });
});
