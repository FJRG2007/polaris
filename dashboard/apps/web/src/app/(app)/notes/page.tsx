/**
 * Notes (/notes): what somebody writes down, on their own or with their team.
 *
 * An app of its own rather than a screen under the account, because that is what
 * it is used as. The account is where you go to change something about yourself
 * and leave; notes are somewhere you sit and work, next to Tasks, and a place
 * you open twenty times a day does not belong behind a settings menu.
 *
 * Every shelf is read here, in one pass, because the sidebar shows all of them
 * at once and a note on one can be moved onto another. What "all of them" means
 * is `shelfSpaceIds` - authorization narrowed to the workspace the reader has
 * open - and the note named in the address is resolved through the full
 * authorization instead, so a pasted link always opens whatever shelf is
 * selected.
 */

import * as access from "@/lib/notes/access";
import { requirePermission } from "@/lib/session";
import { NewNoteButton, NotesView } from "./notes-view";
import { listShelves } from "@/lib/notes/shelf-service";
import { getNote, listNotes } from "@/lib/notes/note-service";

export const dynamic = "force-dynamic";

export default async function NotesPage({
    searchParams
}: {
    searchParams: Promise<{ note?: string }>;
}) {
    const user = await requirePermission("notes.use");
    const actor: access.NoteActor = { id: user.id, isAdmin: user.isAdmin };
    const wanted = (await searchParams).note ?? null;

    const spaceIds = await access.shelfSpaceIds(actor);
    const [shelves, note] = await Promise.all([
        listShelves(actor, spaceIds),
        wanted ? openable(actor, wanted) : Promise.resolve(null)
    ]);

    const withNotes = await Promise.all(
        shelves.map(async (shelf) => ({
            ...shelf,
            notes: await listNotes({ userId: user.id, spaceId: shelf.space?.id ?? null })
        }))
    );

    return (
        <div className="flex w-full flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">Notes</h1>
                    <p className="text-sm text-muted-foreground">
                        Yours alone unless you put it in a notebook. Mention people and tasks the way you
                        would anywhere else in Polaris.
                    </p>
                </div>
                <NewNoteButton />
            </div>
            <NotesView shelves={withNotes} note={note} />
        </div>
    );
}

/** The note in the address, if this reader may open it. A refusal reads as no
 *  note rather than as an error: a stale link is a link, not a fault. */
async function openable(actor: access.NoteActor, noteId: string) {
    try {
        await access.requireNote(actor, noteId, "guest");
    } catch {
        return null;
    }
    return getNote(noteId);
}
