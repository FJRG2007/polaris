/**
 * Notes (/account/notes): what somebody writes down for themselves.
 *
 * It sits under the account rather than inside Tasks because that is what it
 * belongs to. A note is not work in a space somebody could be removed from, and
 * it does not go with the organization whose shelf happens to be open - it goes
 * with the person, and it goes when the account does.
 */

import { requireUser } from "@/lib/session";
import { NewNoteButton, NotesView } from "./notes-view";
import { getNote, listNotes } from "@/lib/notes/note-service";

export const dynamic = "force-dynamic";

export default async function NotesPage({
    searchParams
}: {
    searchParams: Promise<{ note?: string }>;
}) {
    const user = await requireUser();
    const wanted = (await searchParams).note ?? null;
    const [notes, note] = await Promise.all([
        listNotes(user.id),
        wanted ? getNote(user.id, wanted) : Promise.resolve(null)
    ]);

    return (
        <div className="flex w-full flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h1 className="text-lg font-semibold">Notes</h1>
                    <p className="text-sm text-muted-foreground">
                        Yours alone. Mention people and tasks the way you would anywhere else in Polaris.
                    </p>
                </div>
                <NewNoteButton />
            </div>
            <NotesView notes={notes} note={note} />
        </div>
    );
}
