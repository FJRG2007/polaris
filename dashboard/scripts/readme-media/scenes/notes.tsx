/** Notes: a note open beside every shelf the viewer writes on. */

import { Chrome } from "../runtime/chrome";
import { label } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { NewNoteButton, NotesView } from "@/app/(app)/notes/notes-view";
import { noteShelves, openNote } from "../fixtures/notes";

export const notes = defineScene({
    id: "notes",
    path: "/notes",
    // The page `/notes` draws, with what it would have read.
    render: (ctx) => (
        <Chrome>
            <div className="flex w-full flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                            {label(ctx.locale, "notes.archive.notesTitle")}
                        </h1>
                        <p className="text-sm text-muted-foreground">
                            {label(ctx.locale, "notes.archive.notesDescription")}
                        </p>
                    </div>
                    <NewNoteButton />
                </div>
                <NotesView shelves={noteShelves(ctx)} note={openNote(ctx)} />
            </div>
        </Chrome>
    )
});
