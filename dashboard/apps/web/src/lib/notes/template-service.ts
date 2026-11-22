/**
 * Note templates: a title and a body a new note starts from.
 *
 * A template sits on a shelf exactly as a note does - `spaceId` null is its
 * owner's private shelf and nobody else's, a space's is read by whoever reaches
 * that space - so the access rule is the one `requireShelf` already answers and
 * nothing here invents another. Reading takes the shelf's `guest` role; adding,
 * renaming, choosing the default and deleting take `member`, the role that may
 * write notes there.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { NoteAccessError, requireNote, requireShelf, type NoteActor } from "@/lib/notes/access";

export interface NoteTemplateSummary {
    readonly id: string;
    readonly spaceId: string | null;
    readonly name: string;
    readonly isDefault: boolean;
}

/** Every template on the shelves the page lists, in one read: the reader's own
 *  private ones and those of the spaces passed in, which the caller has already
 *  authorized. Default first, then by name. */
export async function listTemplates(
    actor: NoteActor,
    spaceIds: readonly string[]
): Promise<NoteTemplateSummary[]> {
    return prisma.noteTemplate.findMany({
        where: {
            OR: [
                { spaceId: null, ownerId: actor.id },
                ...(spaceIds.length ? [{ spaceId: { in: [...spaceIds] } }] : [])
            ]
        },
        orderBy: [{ isDefault: "desc" }, { name: "asc" }],
        take: core.NOTE_TEMPLATES_MAX * (spaceIds.length + 1),
        select: { id: true, spaceId: true, name: true, isDefault: true }
    });
}

/** A template, once the actor has been allowed `minimum` on its shelf. */
async function requireTemplate(actor: NoteActor, templateId: string, minimum: core.SpaceRole) {
    const template = await prisma.noteTemplate.findUnique({
        where: { id: templateId },
        select: { id: true, ownerId: true, spaceId: true, title: true, body: true }
    });
    if (!template) throw new NoteAccessError("That template no longer exists");
    await requireShelf(actor, { spaceId: template.spaceId, ownerId: template.ownerId }, minimum);
    return template;
}

/**
 * The title and text a new note copies, when it is being written onto the
 * template's own shelf. A template from another shelf is refused rather than
 * applied: its text would carry one notebook's content into another.
 */
export async function templateForPlacement(
    actor: NoteActor,
    templateId: string,
    spaceId: string | null
): Promise<{ title: string; body: string }> {
    const template = await requireTemplate(actor, templateId, "guest");
    if ((template.spaceId ?? null) !== (spaceId ?? null))
        throw new NoteAccessError("That template is on a different notebook");
    return { title: template.title, body: template.body };
}

/** "Use this note as a template": its title and text, saved on its shelf. The
 *  first template on a shelf becomes its default, since one is all there is. */
export async function templateFromNote(
    actor: NoteActor,
    input: { noteId: string; name: string }
): Promise<string> {
    const note = await requireNote(actor, input.noteId, "member");
    const shelf = note.spaceId ? { spaceId: note.spaceId } : { spaceId: null, ownerId: actor.id };
    const [source, count] = await Promise.all([
        prisma.note.findUnique({ where: { id: note.noteId }, select: { title: true, body: true } }),
        prisma.noteTemplate.count({ where: shelf })
    ]);
    if (!source) throw new NoteAccessError("That note no longer exists");
    if (count >= core.NOTE_TEMPLATES_MAX)
        throw new NoteAccessError(`A notebook keeps at most ${core.NOTE_TEMPLATES_MAX} templates`);
    const created = await prisma.noteTemplate.create({
        data: {
            ownerId: actor.id,
            spaceId: note.spaceId,
            name: input.name,
            title: source.title,
            body: source.body,
            isDefault: count === 0
        },
        select: { id: true }
    });
    return created.id;
}

/** Rename a template or make it (or stop it being) the shelf's default. Making
 *  one the default unsets the others in the same transaction. */
export async function updateTemplate(
    actor: NoteActor,
    input: core.NoteTemplateUpdateInput
): Promise<void> {
    const template = await requireTemplate(actor, input.templateId, "member");
    const shelf = template.spaceId
        ? { spaceId: template.spaceId }
        : { spaceId: null, ownerId: template.ownerId };
    await prisma.$transaction([
        ...(input.isDefault
            ? [
                  prisma.noteTemplate.updateMany({
                      where: { ...shelf, isDefault: true, id: { not: template.id } },
                      data: { isDefault: false }
                  })
              ]
            : []),
        prisma.noteTemplate.update({
            where: { id: template.id },
            data: {
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {})
            }
        })
    ]);
}

export async function deleteTemplate(actor: NoteActor, templateId: string): Promise<void> {
    const template = await requireTemplate(actor, templateId, "member");
    await prisma.noteTemplate.deleteMany({ where: { id: template.id } });
}
