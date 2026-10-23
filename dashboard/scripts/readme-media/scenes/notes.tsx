/** Notes: a note open beside every shelf the viewer writes on. */

import { tourScene } from "../runtime/tour";
import { Chrome } from "../runtime/chrome";
import { label, once } from "../runtime/interact";
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

/**
 * On a phone the shelves and the open note stack in one column, with the note
 * under every shelf; bring it up the way a thumb scrolls to it.
 */
async function noteInView(ctx: Parameters<typeof openNote>[0]) {
    if (window.matchMedia("(min-width: 1024px)").matches) return;
    const title = openNote(ctx).title;
    await once(() => {
        const field = [...document.querySelectorAll("input")].find((input) => input.value === title);
        if (!field) throw new Error("the note did not open");
        (field.parentElement?.previousElementSibling ?? field).scrollIntoView({ block: "start" });
    });
}

/** Every shelf, then a note opened on one of them. */
export const notes = tourScene([notesPage(true), notesPage(false)], [
    { view: 1, hold: 1600 },
    { view: 0, run: (ctx) => noteInView(ctx), hold: 3400 }
]);
