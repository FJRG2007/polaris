/**
 * Backlinks: which notes link to this one.
 *
 * The body is the truth and `NoteLink` is an index of it, rewritten from the
 * body every time one is saved, so "what links here" is one read by target
 * instead of a scan of every body. Reading the index never widens access: a
 * linking note is listed only when the reader could open it themselves - their
 * own private shelf, a space they reach, or a note shared with them by name.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { grantedSubjects } from "@/lib/access/grants";
import { visibleSpaceIds, type NoteActor } from "@/lib/notes/access";

/** The most backlinks one note lists. A hub note linked from thousands is
 *  read from the top, most recently touched first. */
export const BACKLINKS_MAX = 100;

export interface Backlink {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: string;
}

/**
 * Rewrite one note's outgoing links from its body.
 *
 * Only targets that exist are written, so a link to a deleted or mistyped note
 * leaves no dangling row; a target deleted later goes with its rows. Two
 * statements and an existence check, whatever the number of links.
 */
export async function syncNoteLinks(sourceId: string, body: string): Promise<void> {
    const wanted = core.noteLinkTargets(body).filter((id) => id !== sourceId);
    const existing = wanted.length
        ? await prisma.note.findMany({ where: { id: { in: wanted } }, select: { id: true } })
        : [];
    const targets = existing.map((row) => row.id);
    await prisma.$transaction([
        prisma.noteLink.deleteMany({
            where: { sourceId, ...(targets.length ? { targetId: { notIn: targets } } : {}) }
        }),
        ...(targets.length
            ? [
                  prisma.noteLink.createMany({
                      data: targets.map((targetId) => ({ sourceId, targetId })),
                      skipDuplicates: true
                  })
              ]
            : [])
    ]);
}

/**
 * Index a batch of freshly written notes at once - an import - in a bounded
 * number of statements rather than one sync per note.
 */
export async function indexNoteLinks(
    notes: readonly { id: string; body: string }[]
): Promise<void> {
    const pairs = notes.flatMap((note) =>
        core
            .noteLinkTargets(note.body)
            .filter((id) => id !== note.id)
            .map((targetId) => ({ sourceId: note.id, targetId }))
    );
    if (pairs.length === 0) return;
    const ids = [...new Set(pairs.map((pair) => pair.targetId))];
    const present = new Set<string>();
    for (let at = 0; at < ids.length; at += 1000) {
        const rows = await prisma.note.findMany({
            where: { id: { in: ids.slice(at, at + 1000) } },
            select: { id: true }
        });
        for (const row of rows) present.add(row.id);
    }
    const data = pairs.filter((pair) => present.has(pair.targetId));
    for (let at = 0; at < data.length; at += 1000) {
        await prisma.noteLink.createMany({ data: data.slice(at, at + 1000), skipDuplicates: true });
    }
}

/**
 * The notes linking to `noteId` that this reader may open. The caller has
 * already been allowed to open `noteId` itself.
 */
export async function listBacklinks(actor: NoteActor, noteId: string): Promise<Backlink[]> {
    const [spaceIds, sharedNotes] = await Promise.all([
        visibleSpaceIds(actor),
        grantedSubjects(actor.id, "note.note")
    ]);
    const rows = await prisma.note.findMany({
        where: {
            archived: false,
            linksOut: { some: { targetId: noteId } },
            OR: [
                { spaceId: null, userId: actor.id },
                ...(spaceIds.length ? [{ spaceId: { in: spaceIds } }] : []),
                ...(sharedNotes.size ? [{ id: { in: [...sharedNotes.keys()] } }] : [])
            ]
        },
        orderBy: { updatedAt: "desc" },
        take: BACKLINKS_MAX,
        select: { id: true, title: true, updatedAt: true }
    });
    return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}
