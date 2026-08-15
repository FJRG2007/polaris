/**
 * Where notes used to live.
 *
 * They are an app of their own now (/notes). This stays because links to a note
 * are written into other notes, into tasks, and into whatever somebody pasted
 * into a chat months ago, and a reference that stops resolving is worse than a
 * hop. The query is carried across, so a link to one particular note still opens
 * that note.
 */

import { redirect } from "next/navigation";

export default async function MovedNotesPage({
    searchParams
}: {
    searchParams: Promise<{ note?: string }>;
}) {
    const wanted = (await searchParams).note;
    redirect(wanted ? `/notes?note=${encodeURIComponent(wanted)}` : "/notes");
}
