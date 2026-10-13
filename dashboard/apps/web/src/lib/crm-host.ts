/**
 * What the CRM app needs from the dashboard beyond what other apps take: which
 * shelf the reader is working from, what their organization's roles let them do
 * there, and who is on that shelf to own a record.
 *
 * Each function is one of the dashboard's own services narrowed to the question
 * the app asks, so `lib/app-host/server.ts` can hand it over without handing the
 * app the whole module behind it.
 *
 * Server-only.
 */

import { resolveScope } from "@/lib/workspace-scope";
import { listOrgMembers, orgCan, resolveOrgAccess, type OrgActor } from "@/lib/orgs/org-service";

/** The shelf somebody is working from: an organization, or their own (null). */
export interface CrmShelf {
    readonly orgId: string | null;
    readonly orgName: string | null;
}

/** The shelf open in this request, with the membership re-checked. */
export async function crmShelf(userId: string): Promise<CrmShelf> {
    const { org } = await resolveScope(userId);
    return { orgId: org?.id ?? null, orgName: org?.name ?? null };
}

/**
 * What this account's role holds in one organization, or null when it is not
 * theirs to see. The wildcard comes back as is; `hasOrgPermission` from
 * `@polaris/core` reads it.
 */
export async function crmOrgPermissions(
    actor: OrgActor,
    orgId: string
): Promise<readonly string[] | null> {
    return (await resolveOrgAccess(actor, orgId))?.permissions ?? null;
}

/** Somebody who can own a record on a shelf. */
export interface CrmShelfPerson {
    readonly id: string;
    readonly name: string;
    /** Their address or handle, as far as they let this reader see it. */
    readonly contact: string;
}

/**
 * Who may be named as a record's owner on an organization's shelf: its roster,
 * with each line under a name as private as the roster screen draws it.
 * Nobody, for a reader whose role does not see the roster.
 */
export async function crmOrgPeople(actor: OrgActor, orgId: string): Promise<CrmShelfPerson[]> {
    if (!orgCan(await resolveOrgAccess(actor, orgId), "org.read")) return [];
    return (await listOrgMembers(orgId, actor)).map((member) => ({
        id: member.userId,
        name: member.name,
        contact: member.contact
    }));
}

/** A note as a CRM record lists it. */
export interface CrmNote {
    readonly id: string;
    readonly title: string;
    /** The opening of its text, plain. */
    readonly excerpt: string;
    readonly updatedAt: string;
}

/** A Notes shelf a note can be written on from a record: null is the reader's own. */
export interface CrmNoteShelf {
    readonly id: string | null;
    readonly name: string;
}

async function mayUseNotes(actor: OrgActor): Promise<boolean> {
    if (actor.isAdmin) return true;
    const { userHasPermission } = await import("@polaris/auth");
    return userHasPermission(actor.id, "notes.use");
}

/**
 * Some notes by id, as far as this account may read them in Notes: one gone,
 * archived, or on a shelf that is not theirs is left out. In the order given.
 */
export async function crmNotesByIds(actor: OrgActor, ids: readonly string[]): Promise<CrmNote[]> {
    if (ids.length === 0 || !(await mayUseNotes(actor))) return [];
    const { prisma } = await import("@polaris/db");
    const access = await import("@/lib/notes/access");
    const spaces = await access.visibleSpaceIds(actor);
    const rows = await prisma.note.findMany({
        where: {
            id: { in: ids.slice(0, 200) },
            archived: false,
            OR: [{ spaceId: null, userId: actor.id }, { spaceId: { in: spaces } }]
        },
        select: { id: true, title: true, body: true, updatedAt: true }
    });
    const found = new Map(
        rows.map((row) => [
            row.id,
            {
                id: row.id,
                title: row.title,
                excerpt: row.body
                    .replace(/[#>*_`~[\]()!-]+/g, " ")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 160),
                updatedAt: row.updatedAt.toISOString()
            }
        ])
    );
    return ids.flatMap((id) => found.get(id) ?? []);
}

/**
 * Where this account may write a note from a record: its own shelf, then every
 * Notes space of the open workspace it is a member or better of. Null when it
 * may not use Notes at all.
 */
export async function crmNoteShelves(actor: OrgActor): Promise<CrmNoteShelf[] | null> {
    if (!(await mayUseNotes(actor))) return null;
    const { prisma } = await import("@polaris/db");
    const core = await import("@polaris/core");
    const access = await import("@/lib/notes/access");
    const ids = await access.shelfSpaceIds(actor);
    const spaces = await prisma.noteSpace.findMany({
        where: { id: { in: ids }, archived: false },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 50
    });
    const roles = await Promise.all(
        spaces.map((space) => access.resolveSpaceRole(actor, space.id))
    );
    return [
        { id: null, name: "" },
        ...spaces.filter((_, at) => {
            const role = roles[at];
            return role === "owner" || (role !== null && core.spaceRoleAtLeast(role!, "member"));
        })
    ];
}

/**
 * Write a note from a record, on the reader's shelf or a space they may write
 * in, through the Notes service. A refusal comes back as its sentence.
 */
export async function crmCreateNote(
    actor: OrgActor,
    input: { title: string; body: string; spaceId: string | null }
): Promise<{ id: string } | { refused: string }> {
    if (!(await mayUseNotes(actor))) return { refused: "" };
    const core = await import("@polaris/core");
    const access = await import("@/lib/notes/access");
    const notes = await import("@/lib/notes/note-service");
    const parsed = core.noteCreateSchema.safeParse({
        title: input.title,
        body: input.body,
        spaceId: input.spaceId
    });
    if (!parsed.success) return { refused: parsed.error.issues[0]?.message ?? "" };
    try {
        await access.requirePlacement(actor, { spaceId: input.spaceId, folderId: null });
        return { id: await notes.createNote(actor.id, parsed.data) };
    } catch (caught) {
        if (caught instanceof access.NoteAccessError) return { refused: caught.message };
        throw caught;
    }
}
