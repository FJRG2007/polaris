/** Notes: a note open beside every shelf the viewer writes on. */

import { tourScene } from "../runtime/tour";
import { Chrome } from "../runtime/chrome";
import { label } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { NewNoteButton, NotesView } from "@/app/(app)/notes/notes-view";
import { noteShelves, openNote } from "../fixtures/notes";

/** The page `/notes` draws, with what it would have read: a note open, or none yet. */
function notesPage(open: boolean) {
    return defineScene({
    id: "notes",
    path: "/notes",
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
                <NotesView shelves={noteShelves(ctx)} note={open ? openNote(ctx) : null} />
            </div>
        </Chrome>
    )
    });
}

/** Every shelf, then a note opened on one of them. */
export const notes = tourScene([notesPage(true), notesPage(false)], [
    { view: 1, hold: 1600 },
    { view: 0, hold: 3400 }
]);
