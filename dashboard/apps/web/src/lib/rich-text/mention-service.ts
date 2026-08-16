/**
 * What @ and # can find, and how far the person typing is allowed to look.
 *
 * A mention picker is a search over other people's work, so it answers with the
 * same scope every other Tasks query uses: spaces this account reaches, teams of
 * organizations it belongs to, and its own pages and notes. Nothing here widens
 * access - naming something in a description does not grant it, and a task the
 * reader cannot open is a task they cannot mention either.
 *
 * The label is resolved once, here, and stored with the reference. A chip that
 * had to look its own name up would be a query per chip on every render.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import * as access from "@/lib/tasks/access";
import { memberOrgIds } from "@/lib/orgs/org-service";
import { conversationAudience } from "@/lib/chat/access";
import type { ReferenceKind } from "@/components/rich-text/references";

/** One row of the picker. */
export interface MentionCandidate {
    readonly kind: ReferenceKind;
    readonly id: string;
    readonly label: string;
    /** The line underneath: which space a task is in, which organization owns a
     *  team. Empty when the label already says everything. */
    readonly detail: string;
    readonly image: string | null;
    /** A task's own handle, "PLR-42". The global search shows it beside the
     *  name, where the picker folds it into the detail line. */
    readonly reference?: string;
    /** Where it lives, on its own. The picker's detail line says the handle and
     *  the space together; a surface drawing the handle as a badge needs the
     *  other half without it. */
    readonly place?: string;
    /** Where a task stands, for surfaces that draw it rather than say it. */
    readonly status?: { readonly name: string; readonly color: string } | null;
}

/** One account, as a field that names people by their sign-in identity needs
 *  it: the picker shows the person, but what gets stored is what the server
 *  matches on later. */
export interface AccountCandidate {
    readonly id: string;
    readonly name: string;
    /** Null on an account that never set one; then the email is the identity. */
    readonly username: string | null;
    readonly email: string;
    readonly image: string | null;
}

/** How many of each kind one search returns, so a popup stays a popup. The
 *  global search asks for more, because a panel is not a popup. */
const PER_KIND = 6;

/** "PLR-42" and "42" both mean a number, which is how people quote a task. */
const REFERENCE_QUERY = /^([a-z]+)?-?(\d+)$/i;

/**
 * A case-insensitive "contains", spelled the way the engine underneath wants it.
 *
 * Postgres has to be told; SQLite's LIKE already ignores case for ASCII and
 * rejects being told, and the container-free local setup runs on SQLite. Typing
 * "ana" and being shown nothing because the account is called "Ana" is the whole
 * reason this is not just `{ contains }`.
 */
export function like(term: string) {
    return loadEnv().POLARIS_DB_PROVIDER === "sqlite"
        ? { contains: term }
        : { contains: term, mode: "insensitive" as const };
}

/**
 * Search everything one trigger offers.
 *
 * @param actor - The caller, already past the instance permission check.
 * @param kinds - What this trigger looks for: people and teams for @, work for #.
 * @param query - What has been typed after the trigger. Empty offers recents.
 * @param limit - Rows per kind. The default is what a popup can show.
 */
export async function searchMentions(
    actor: access.TaskActor,
    kinds: readonly ReferenceKind[],
    query: string,
    limit: number = PER_KIND,
    /** Where the caret is, when that changes who may be named. */
    where?: { readonly channelId?: string }
): Promise<MentionCandidate[]> {
    const term = query.trim();
    const wanted = new Set(kinds);
    const [people, teams, work] = await Promise.all([
        wanted.has("user") ? searchPeople(actor, term, limit, where?.channelId) : [],
        wanted.has("team") ? searchTeams(actor, term, limit) : [],
        wanted.has("task") || wanted.has("doc") || wanted.has("note")
            ? searchWork(actor, wanted, term, limit)
            : []
    ]);
    return [...people, ...teams, ...work];
}

/**
 * People this account already shares work with: whoever is on a space it
 * reaches, plus everyone on the roster of an organization it belongs to. An
 * instance admin sees everybody, the same way they do everywhere else.
 *
 * Inside a conversation it is the conversation instead - the people in the room,
 * as every messenger does it. Shared work is the wrong question there: two
 * people whose only connection is the direct message they are sitting in could
 * not name each other in it, and nothing said so. The room is also narrower than
 * the default for a guest of one channel, so this replaces the reach rather than
 * adding to it.
 */
async function searchPeople(
    actor: access.TaskActor,
    term: string,
    limit: number,
    channelId?: string
): Promise<MentionCandidate[]> {
    const contains = term ? like(term) : undefined;
    const inRoom = channelId ? await conversationAudience({ id: actor.id }, channelId) : null;
    // Null means this account cannot reach that conversation - somebody typing
    // into a channel they were just removed from, or a bad id. Falling back to
    // the ordinary reach rather than refusing: a caret is not worth an error.
    const scope = inRoom ?? (actor.isAdmin ? null : await reachablePeople(actor));
    const users = await prisma.user.findMany({
        where: {
            ...(scope ? { id: { in: scope } } : {}),
            ...(contains ? { OR: [{ name: contains }, { email: contains }] } : {})
        },
        select: { id: true, name: true, email: true, image: true },
        orderBy: { name: "asc" },
        take: limit
    });
    return users.map((user) => ({
        kind: "user" as const,
        id: user.id,
        label: user.name || user.email,
        detail: user.name ? user.email : "",
        image: user.image
    }));
}

/**
 * The same people, for a field that stores an identity rather than a mention.
 *
 * A drop point's allowlist, a successor, somebody being given a server: all of
 * them are matched later by username or email, so the picker has to hand back
 * the identity and not the id. The reach is deliberately the one above - naming
 * an account in a field does not make it visible, and a picker that offered the
 * whole instance would be a user directory nobody agreed to publish.
 *
 * @param actor - The caller, already past the permission check.
 * @param query - What has been typed. Empty offers the first names in reach.
 * @param limit - Rows to return. The default is what a popup can show.
 */
export async function searchAccounts(
    actor: access.TaskActor,
    query: string,
    limit: number = PER_KIND
): Promise<AccountCandidate[]> {
    const term = query.trim();
    const contains = term ? like(term) : undefined;
    const scope = actor.isAdmin ? null : await reachablePeople(actor);
    const users = await prisma.user.findMany({
        where: {
            ...(scope ? { id: { in: scope } } : {}),
            ...(contains
                ? { OR: [{ name: contains }, { email: contains }, { username: contains }] }
                : {})
        },
        select: { id: true, name: true, username: true, email: true, image: true },
        orderBy: { name: "asc" },
        take: limit
    });
    return users.map((user) => ({
        id: user.id,
        name: user.name || user.email,
        username: user.username,
        email: user.email,
        image: user.image
    }));
}

/** The ids of everybody reachable, resolved once for the query above. */
async function reachablePeople(actor: access.TaskActor): Promise<string[]> {
    const scope = await access.visibleScope(actor);
    const spaceIds = access.scopeSpaceIds(scope);
    const orgIds = await memberOrgIds(actor.id);
    const [members, folderGrants, roster] = await Promise.all([
        prisma.taskSpaceMember.findMany({ where: { spaceId: { in: spaceIds } }, select: { userId: true } }),
        prisma.taskFolderMember.findMany({
            where: { folder: { spaceId: { in: spaceIds } } },
            select: { userId: true }
        }),
        prisma.organizationMember.findMany({ where: { orgId: { in: orgIds } }, select: { userId: true } })
    ]);
    return [
        actor.id,
        ...members.map((row) => row.userId),
        ...folderGrants.map((row) => row.userId),
        ...roster.map((row) => row.userId)
    ];
}

/** Teams are an organization's groups, so the roster is the boundary. */
async function searchTeams(actor: access.TaskActor, term: string, limit: number): Promise<MentionCandidate[]> {
    const orgIds = await memberOrgIds(actor.id);
    if (orgIds.length === 0 && !actor.isAdmin) return [];
    const teams = await prisma.team.findMany({
        where: {
            ...(actor.isAdmin ? {} : { orgId: { in: orgIds } }),
            ...(term ? { name: like(term) } : {})
        },
        select: { id: true, name: true, org: { select: { name: true } } },
        orderBy: { name: "asc" },
        take: limit
    });
    return teams.map((team) => ({
        kind: "team" as const,
        id: team.id,
        label: team.name,
        detail: team.org.name,
        image: null
    }));
}

/**
 * The names behind a set of addresses.
 *
 * Used when a link is pasted rather than picked: the address is in the URL, the
 * name is not. Anything the caller cannot reach comes back without a name rather
 * than as an error, so a paste never turns into a permission message - the chip
 * simply keeps saying what was pasted.
 */
export async function resolveReferences(
    actor: access.TaskActor,
    targets: readonly { kind: ReferenceKind; id: string }[]
): Promise<Record<string, string>> {
    if (targets.length === 0) return {};
    const idsOf = (kind: ReferenceKind) => targets.filter((target) => target.kind === kind).map((target) => target.id);
    const scope = await access.visibleScope(actor);

    const [users, teams, tasks, docs, notes] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: idsOf("user") } }, select: { id: true, name: true, email: true } }),
        prisma.team.findMany({ where: { id: { in: idsOf("team") } }, select: { id: true, name: true } }),
        prisma.task.findMany({
            where: { AND: [{ id: { in: idsOf("task") } }, access.scopeTaskWhere(scope)] },
            select: { id: true, name: true }
        }),
        prisma.taskDoc.findMany({
            where: {
                id: { in: idsOf("doc") },
                OR: [{ spaceId: { in: access.scopeSpaceIds(scope) } }, { spaceId: null, createdById: actor.id }]
            },
            select: { id: true, title: true }
        }),
        prisma.note.findMany({
            where: { id: { in: idsOf("note") }, userId: actor.id },
            select: { id: true, title: true }
        })
    ]);

    const labels: Record<string, string> = {};
    for (const user of users) labels[`user/${user.id}`] = user.name || user.email;
    for (const team of teams) labels[`team/${team.id}`] = team.name;
    for (const task of tasks) labels[`task/${task.id}`] = task.name;
    for (const doc of docs) labels[`doc/${doc.id}`] = doc.title;
    for (const note of notes) labels[`note/${note.id}`] = note.title;
    return labels;
}

/** Tasks, pages and notes, each inside what this account already reads. */
async function searchWork(
    actor: access.TaskActor,
    wanted: ReadonlySet<ReferenceKind>,
    term: string,
    limit: number
): Promise<MentionCandidate[]> {
    const scope = await access.visibleScope(actor);
    const spaceIds = access.scopeSpaceIds(scope);
    const numbered = REFERENCE_QUERY.exec(term);
    const contains = term ? like(term) : undefined;

    const [tasks, docs, notes] = await Promise.all([
        wanted.has("task")
            ? prisma.task.findMany({
                  where: {
                      AND: [
                          access.scopeTaskWhere(scope),
                          { archived: false },
                          term
                              ? {
                                    OR: [
                                        { name: contains },
                                        ...(numbered ? [{ number: Number(numbered[2]) }] : [])
                                    ]
                                }
                              : {}
                      ]
                  },
                  select: {
                      id: true,
                      name: true,
                      number: true,
                      space: { select: { name: true, prefix: true } },
                      status: { select: { name: true, color: true } }
                  },
                  orderBy: { updatedAt: "desc" },
                  take: limit
              })
            : [],
        wanted.has("doc")
            ? prisma.taskDoc.findMany({
                  where: {
                      archived: false,
                      OR: [{ spaceId: { in: spaceIds } }, { spaceId: null, createdById: actor.id }],
                      ...(term ? { title: contains } : {})
                  },
                  select: { id: true, title: true, space: { select: { name: true } } },
                  orderBy: { updatedAt: "desc" },
                  take: limit
              })
            : [],
        wanted.has("note")
            ? prisma.note.findMany({
                  where: { userId: actor.id, archived: false, ...(term ? { title: contains } : {}) },
                  select: { id: true, title: true },
                  orderBy: { updatedAt: "desc" },
                  take: limit
              })
            : []
    ]);

    return [
        ...tasks.map((task) => ({
            kind: "task" as const,
            id: task.id,
            label: task.name,
            detail: `${core.taskReference(task.space.prefix, task.number)} in ${task.space.name}`,
            image: null,
            reference: core.taskReference(task.space.prefix, task.number),
            place: task.space.name,
            status: task.status ? { name: task.status.name, color: task.status.color } : null
        })),
        ...docs.map((doc) => ({
            kind: "doc" as const,
            id: doc.id,
            label: doc.title,
            detail: doc.space?.name ?? "Page",
            image: null
        })),
        ...notes.map((note) => ({
            kind: "note" as const,
            id: note.id,
            label: note.title,
            detail: "Note",
            image: null
        }))
    ];
}
