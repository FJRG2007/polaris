/**
 * The archive (/notes/archive).
 *
 * Archiving exists so the sidebar can be about what somebody is working on
 * without deleting what they are not. That only works if there is somewhere to
 * look afterwards - an archive with no screen is a delete with extra steps, and
 * for a while that is exactly what it was.
 */

import { ArchiveView } from "./archive-view";
import { requirePermission } from "@/lib/session";
import { listArchivedNotes } from "@/lib/notes/note-service";

export const dynamic = "force-dynamic";

export default async function NotesArchivePage() {
    const user = await requirePermission("notes.use");
    const notes = await listArchivedNotes(user.id);

    return (
        <div className="flex w-full flex-col gap-4">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">Archive</h1>
                <p className="text-sm text-muted-foreground">
                    Notes you have put away. Nothing here is deleted. Putting one back returns it
                    where it sat, or to the top level if that note is still archived.
                </p>
            </div>
            <ArchiveView notes={notes} />
        </div>
    );
}
