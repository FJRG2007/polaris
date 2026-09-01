/**
 * Notes (/notes): what somebody writes down for themselves.
 *
 * An app of its own rather than a screen under the account, because that is what
 * it is used as. The account is where you go to change something about yourself
 * and leave; notes are somewhere you sit and work, next to Tasks, and a place
 * you open twenty times a day does not belong behind a settings menu.
 *
 * What has not changed is who can read them: nobody but the author, an instance
 * administrator included, and they go when the account does.
 */

import { requirePermission } from "@/lib/session";
import { NewNoteButton, NotesView } from "./notes-view";
import { getNote, listNotes } from "@/lib/notes/note-service";

export const dynamic = "force-dynamic";

export default async function NotesPage({
    searchParams
}: {
    searchParams: Promise<{ note?: string }>;
}) {
    const user = await requirePermission("notes.use");
    const wanted = (await searchParams).note ?? null;
    const [notes, note] = await Promise.all([
        listNotes(user.id),
        wanted ? getNote(user.id, wanted) : Promise.resolve(null)
    ]);

    return (
        <div className="flex w-full flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">Notes</h1>
                    <p className="text-sm text-muted-foreground">
                        Yours alone. Mention people and tasks the way you would anywhere else in
                        Polaris.
                    </p>
                </div>
                <NewNoteButton />
            </div>
            <NotesView notes={notes} note={note} />
        </div>
    );
}
