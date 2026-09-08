/**
 * Who may open a document, and everything that happens to one.
 *
 * The one module that answers "may they", for all five kinds. Everything above
 * it takes the resolved role rather than working it out again, which is the same
 * arrangement Tasks, Notes and Chat each settled on and for the same reason: a
 * second copy of an access rule is a second place for it to be wrong.
 *
 * **A document is private until it is shared.** That is the whole model, and it
 * is deliberately not the model a space uses. A space is a room people are put
 * in; a document is a thing somebody made, and being on the same roster as its
 * author is not a reason to read it. What reaches one is:
 *
 * - being its owner;
 * - running the work of the organization that owns it, which is what makes a
 *   company's document survive the person who wrote it leaving;
 * - a grant, to you or to a team or role you are in - see `lib/access/grants.ts`.
 *
 * There is no administrator override and no instance-wide read, exactly as in
 * Chat. An operator who runs the machine can read the database; what they cannot
 * do is open somebody's draft from a screen Polaris drew for them.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { SessionUser } from "@/lib/session";
import { orgIdsWhere } from "@/lib/orgs/org-service";
import { dropGrantsFor, grantedCapability, grantedSubjects } from "@/lib/access/grants";

/** The caller, as the action layer resolved them. */
export interface OfficeActor {
    readonly id: string;
}

export class OfficeAccessError extends Error {
    constructor(message = "That document is not yours to open") {
        super(message);
        this.name = "OfficeAccessError";
    }
}

/** Refused by a rule rather than by who is asking - a title too long, a kind
 *  that cannot export that way. Its own name so a log tells the two apart. */
export class OfficeRuleError extends OfficeAccessError {
    constructor(message: string) {
        super(message);
        this.name = "OfficeRuleError";
    }
}

/** What somebody may do with one document, and why - the second half matters to
 *  the screen, which says "shared with you" differently from "yours". */
export interface OfficeAccess {
    readonly role: core.OfficeRole;
    /** Whether they own it, or run the organization that does. Only an owner may
     *  hand it on or throw it away. */
    readonly owned: boolean;
}

/**
 * What this actor may do with one document, or null when it is not theirs to
 * open.
 *
 * A document in the bin still resolves. Reading what was thrown away is exactly
 * what a bin is for, and putting it back is the thing somebody came to do;
 * writing to one is refused by the write path rather than here.
 */
export async function documentAccess(
    actor: OfficeActor,
    documentId: string
): Promise<OfficeAccess | null> {
    const document = await prisma.officeDocument.findUnique({
        where: { id: documentId },
        select: { ownerId: true, orgId: true }
    });
    if (!document) return null;
    if (document.ownerId === actor.id) return { role: "editor", owned: true };

    // Whoever the organization trusted with its work. Read off the permission
    // rather than off a role's name: an organization names its own roles, and
    // matching on "admin" lists a document to somebody the roster says runs the
    // work and then refuses them when they open it.
    if (document.orgId) {
        const running = await orgIdsWhere({ id: actor.id, isAdmin: false }, "spaces.manage");
        if (running.includes(document.orgId)) return { role: "editor", owned: true };
    }

    // Handed over. Asked last, after every ordinary standing has said no.
    const granted = await grantedCapability(actor.id, "office.document", documentId);
    return core.isOfficeRole(granted) ? { role: granted, owned: false } : null;
}

/** The same, refused loudly, and at least as strong as `minimum`. */
export async function requireDocument(
    actor: OfficeActor,
    documentId: string,
    minimum: core.OfficeRole = "viewer"
): Promise<OfficeAccess> {
    const access = await documentAccess(actor, documentId);
    if (!access) throw new OfficeAccessError();
    if (!core.officeRoleAtLeast(access.role, minimum)) {
        throw new OfficeAccessError(
            minimum === "editor"
                ? "You can read this document but not change it"
                : "You cannot do that with this document"
        );
    }
    return access;
}

/**
 * Refuse unless this account may hand the document to somebody else.
 *
 * Owning it, or running the organization's work. Being able to edit is
 * deliberately not enough - somebody given a document to work on has not been
 * given the right to decide who else sees it, which is the same line Places
 * draws between opening a door and lending it.
 *
 * Reached from the sharing dispatcher rather than called directly, so "who may
 * share this" lives with the thing being shared.
 */
export async function requireShareable(user: SessionUser, documentId: string): Promise<void> {
    const access = await documentAccess({ id: user.id }, documentId);
    if (!access?.owned) throw new OfficeAccessError("You cannot share that document");
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** One document as a list draws it. Never the content: a list of forty would be
 *  forty CRDT blobs to say forty names. */
export interface OfficeDocumentView {
    readonly id: string;
    readonly kind: core.OfficeKind;
    readonly title: string;
    readonly excerpt: string;
    readonly orgId: string | null;
    readonly orgName: string | null;
    readonly archived: boolean;
    readonly trashed: boolean;
    /** Who touched it last, named, and when. What a shared list is read by. */
    readonly editedBy: string;
    readonly editedAt: string | null;
    readonly createdAt: string;
    /** When this reader last opened it, and whether they keep it to hand. Theirs
     *  rather than the document's - see `OfficeDocumentOpen`. */
    readonly openedAt: string | null;
    readonly starred: boolean;
    /** Whether it reached them through a grant rather than by being theirs. */
    readonly shared: boolean;
}

const LIST_SELECT = {
    id: true,
    kind: true,
    title: true,
    excerpt: true,
    orgId: true,
    archived: true,
    trashedAt: true,
    editedById: true,
    editedAt: true,
    createdAt: true,
    org: { select: { name: true } }
} as const;

type ListRow = {
    id: string;
    kind: string;
    title: string;
    excerpt: string;
    orgId: string | null;
    archived: boolean;
    trashedAt: Date | null;
    editedById: string | null;
    editedAt: Date | null;
    createdAt: Date;
    org: { name: string } | null;
};

/** What a list is asked for. */
export interface OfficeListQuery {
    /** One kind, or "" for all five. */
    readonly kind: core.OfficeKind | "";
    readonly sort: core.OfficeSort;
    /** Which pile: what is live, what was archived, what is in the bin. */
    readonly shelf: "live" | "archived" | "trashed";
    /** Only the ones this reader starred. */
    readonly starredOnly: boolean;
    /** A search over titles and excerpts. */
    readonly query: string;
    readonly limit: number;
}

export const EMPTY_LIST_QUERY: OfficeListQuery = {
    kind: "",
    sort: core.DEFAULT_OFFICE_SORT,
    shelf: "live",
    starredOnly: false,
    query: "",
    limit: 100
};

/**
 * Every document this account reaches, on the shelf it is working from.
 *
 * The shelf narrows what is listed and never what may be read: a link to a
 * document opens whatever shelf happens to be selected, exactly as a link to a
 * task does. So this takes the shelf as a required argument, and a default would
 * be how somebody who switched away is handed a company's drafts.
 */
export async function listDocuments(
    actor: OfficeActor,
    shelfOrgId: string | null,
    query: OfficeListQuery = EMPTY_LIST_QUERY
): Promise<OfficeDocumentView[]> {
    const [running, granted] = await Promise.all([
        orgIdsWhere({ id: actor.id, isAdmin: false }, "spaces.manage"),
        grantedSubjects(actor.id, "office.document")
    ]);
    const sharedIds = [...granted.keys()];

    const rows = await prisma.officeDocument.findMany({
        where: {
            AND: [
                {
                    OR: [
                        { ownerId: actor.id, orgId: null },
                        ...(running.length > 0 ? [{ orgId: { in: running } }] : []),
                        ...(sharedIds.length > 0 ? [{ id: { in: sharedIds } }] : [])
                    ]
                },
                // The shelf: a company's documents on the company's shelf, and
                // somebody's own on their own.
                { orgId: shelfOrgId },
                query.kind ? { kind: query.kind } : {},
                query.shelf === "trashed"
                    ? { trashedAt: { not: null } }
                    : { trashedAt: null, archived: query.shelf === "archived" },
                query.query
                    ? {
                          OR: [
                              { title: { contains: query.query, mode: "insensitive" as const } },
                              { excerpt: { contains: query.query, mode: "insensitive" as const } }
                          ]
                      }
                    : {}
            ]
        },
        select: LIST_SELECT,
        // Ordered in the database for everything but "last opened by me", which
        // lives on another table and is folded in below.
        orderBy:
            query.sort === "title"
                ? { title: "asc" }
                : query.sort === "created"
                  ? { createdAt: "desc" }
                  : { editedAt: "desc" },
        take: Math.min(Math.max(query.limit, 1), 500)
    });
    if (rows.length === 0) return [];

    const [opens, names] = await Promise.all([
        prisma.officeDocumentOpen.findMany({
            where: { userId: actor.id, documentId: { in: rows.map((row) => row.id) } },
            select: { documentId: true, at: true, starred: true }
        }),
        nameEditors(rows)
    ]);
    const mine = new Map(opens.map((open) => [open.documentId, open]));

    const views = rows
        .filter((row) => !query.starredOnly || mine.get(row.id)?.starred)
        .map((row) => viewOf(row, mine.get(row.id) ?? null, names, granted.has(row.id)));

    // The reader's own order, which no database column holds: a document
    // somebody else edited this morning is not more relevant to me than the one
    // I was in yesterday. Anything never opened sorts under everything opened.
    if (query.sort !== "opened") return views;
    return [...views].sort((left, right) => (right.openedAt ?? "").localeCompare(left.openedAt ?? ""));
}

/** The names behind "last edited by", in one query however long the list. */
async function nameEditors(rows: readonly ListRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((row) => row.editedById).filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return new Map();
    const people = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true }
    });
    return new Map(people.map((person) => [person.id, person.name || person.email]));
}

function viewOf(
    row: ListRow,
    open: { at: Date; starred: boolean } | null,
    names: Map<string, string>,
    shared: boolean
): OfficeDocumentView {
    return {
        id: row.id,
        // A row whose kind no longer parses is drawn as a document rather than
        // hidden: it exists, somebody made it, and losing it from the list is
        // worse than opening it in the wrong editor.
        kind: core.isOfficeKind(row.kind) ? row.kind : "doc",
        title: row.title,
        excerpt: row.excerpt,
        orgId: row.orgId,
        orgName: row.org?.name ?? null,
        archived: row.archived,
        trashed: row.trashedAt !== null,
        editedBy: row.editedById ? (names.get(row.editedById) ?? "") : "",
        editedAt: row.editedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        openedAt: open?.at.toISOString() ?? null,
        starred: open?.starred ?? false,
        shared
    };
}

/** One document, with what this reader may do to it. The content comes back as
 *  bytes for the editor to open; everything else is what the chrome draws. */
export async function readDocument(
    actor: OfficeActor,
    documentId: string
): Promise<{ view: OfficeDocumentView; content: Uint8Array | null; access: OfficeAccess } | null> {
    const access = await documentAccess(actor, documentId);
    if (!access) return null;

    const row = await prisma.officeDocument.findUnique({
        where: { id: documentId },
        select: { ...LIST_SELECT, content: true }
    });
    if (!row) return null;

    const [open, names] = await Promise.all([
        prisma.officeDocumentOpen.findUnique({
            where: { documentId_userId: { documentId, userId: actor.id } },
            select: { at: true, starred: true }
        }),
        nameEditors([row])
    ]);
    return {
        view: viewOf(row, open, names, !access.owned),
        content: row.content ? new Uint8Array(row.content) : null,
        access
    };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Make one.
 *
 * The organization is checked rather than trusted: creating for a company takes
 * the standing that runs its work, and a request naming one is a request, not a
 * fact.
 */
export async function createDocument(
    actor: OfficeActor,
    input: core.OfficeCreateInput
): Promise<string> {
    if (input.orgId) {
        const running = await orgIdsWhere({ id: actor.id, isAdmin: false }, "spaces.manage");
        if (!running.includes(input.orgId)) {
            throw new OfficeAccessError("That is not an organization you can create for");
        }
    }
    const written = await prisma.officeDocument.create({
        data: {
            kind: input.kind,
            title: core.normalizeOfficeTitle(input.title, input.kind),
            ownerId: actor.id,
            orgId: input.orgId,
            createdById: actor.id,
            editedById: actor.id,
            editedAt: new Date()
        },
        select: { id: true }
    });
    // Made and opened in one move: whoever creates a document is about to be in
    // it, and a list that shows it as never opened is wrong the moment it draws.
    await touchDocument(actor, written.id);
    return written.id;
}

/** Rename it. An editor may: the title is part of the document, not part of who
 *  reaches it. */
export async function renameDocument(
    actor: OfficeActor,
    documentId: string,
    title: string
): Promise<string> {
    await requireDocument(actor, documentId, "editor");
    const row = await prisma.officeDocument.findUnique({
        where: { id: documentId },
        select: { kind: true }
    });
    const kind = core.isOfficeKind(row?.kind) ? row.kind : "doc";
    const named = core.normalizeOfficeTitle(title, kind);
    await prisma.officeDocument.update({
        where: { id: documentId },
        data: { title: named, editedById: actor.id, editedAt: new Date() }
    });
    return named;
}

/**
 * Fold one person's changes into the document.
 *
 * A **delta** rather than the whole document, and merged here rather than
 * replaced. That is what makes two people typing at once correct instead of
 * merely usually correct: with whole documents, whoever saves second overwrites
 * whoever saved first, and the two only converge if every frame between them
 * arrived. A Yjs update is a set of changes - applying two in either order gives
 * the same document - so the merge is the whole of the concurrency story.
 *
 * The excerpt is worked out from the merged result, not from what arrived: what
 * the list says about a document should describe the document rather than the
 * last paragraph somebody happened to touch.
 */
export async function applyUpdate(
    actor: OfficeActor,
    documentId: string,
    update: Uint8Array
): Promise<void> {
    await requireDocument(actor, documentId, "editor");
    await writeUpdate(documentId, update, actor.id);
}

/**
 * The same write, with the permission already decided.
 *
 * For the one caller that cannot ask `requireDocument`: somebody who arrived
 * with a link and has no account here at all. The link route resolves what they
 * may do before calling this, and `editedById` is null for them - a document
 * edited by a visitor should not name somebody who was not there.
 *
 * Deliberately not exported anywhere a screen can reach: this is the write with
 * the check taken off, and it belongs to the two callers above it.
 */
export async function writeUpdate(
    documentId: string,
    update: Uint8Array,
    editedById: string | null
): Promise<void> {
    const row = await prisma.officeDocument.findUnique({
        where: { id: documentId },
        select: { content: true }
    });
    const { documentState, excerptOf, openDocument } = await import("@/lib/office/content");
    const doc = openDocument(row?.content ? new Uint8Array(row.content) : null);
    const { applyUpdate: applyYjsUpdate } = await import("yjs");
    applyYjsUpdate(doc, update);

    await prisma.officeDocument.update({
        where: { id: documentId },
        data: {
            content: Buffer.from(documentState(doc)),
            excerpt: excerptOf(doc),
            editedById,
            editedAt: new Date()
        }
    });
}

/** Out of the way, or back. Filing is the reader's own and takes only the right
 *  to change the document. */
export async function archiveDocument(
    actor: OfficeActor,
    documentId: string,
    archived: boolean
): Promise<void> {
    await requireDocument(actor, documentId, "editor");
    await prisma.officeDocument.update({ where: { id: documentId }, data: { archived } });
}

/**
 * Into the bin, or back out of it.
 *
 * Only somebody it belongs to. An editor may change every word in a document and
 * still not be the person who decides it stops existing - that is the difference
 * between working on something and owning it.
 */
export async function trashDocument(
    actor: OfficeActor,
    documentId: string,
    trashed: boolean
): Promise<void> {
    const access = await requireDocument(actor, documentId, "editor");
    if (!access.owned) throw new OfficeAccessError("Only the owner can delete this document");
    await prisma.officeDocument.update({
        where: { id: documentId },
        data: { trashedAt: trashed ? new Date() : null }
    });
}

/** Gone, with everything it was shared by. The grants go by hand: they address
 *  their subject by kind and id, so nothing takes them away on its behalf. */
export async function deleteDocument(actor: OfficeActor, documentId: string): Promise<void> {
    const access = await requireDocument(actor, documentId, "editor");
    if (!access.owned) throw new OfficeAccessError("Only the owner can delete this document");
    await dropGrantsFor("office.document", documentId);
    await prisma.officeDocument.delete({ where: { id: documentId } });
}

/** Note that this person has it open, which is what the default order reads.
 *  Written on every open, so it holds nothing else. */
export async function touchDocument(actor: OfficeActor, documentId: string): Promise<void> {
    await prisma.officeDocumentOpen.upsert({
        where: { documentId_userId: { documentId, userId: actor.id } },
        create: { documentId, userId: actor.id },
        update: { at: new Date() }
    });
}

/** Keep it to hand, or stop. Theirs alone: a document I star must not appear
 *  starred to the person who wrote it. */
export async function starDocument(
    actor: OfficeActor,
    documentId: string,
    starred: boolean
): Promise<void> {
    await requireDocument(actor, documentId);
    await prisma.officeDocumentOpen.upsert({
        where: { documentId_userId: { documentId, userId: actor.id } },
        create: { documentId, userId: actor.id, starred },
        update: { starred }
    });
}
