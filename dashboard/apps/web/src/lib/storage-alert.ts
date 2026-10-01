/**
 * Telling an administrator that the storage uploads go to has stopped answering.
 *
 * An upload that finds its storage gone is kept on the disk Polaris runs on
 * instead, which is the right thing for the person sending it and the wrong thing
 * to keep quiet about: every file from then on lands somewhere the operator did
 * not choose, and the only trace was a line in a container log nobody reads. So
 * the people who can fix it are told, by name of the storage and in their own
 * language, with the screen that checks it one press away.
 *
 * Said once per storage per window rather than once per upload: a NAS that is off
 * for an afternoon is one notice, not one per photo somebody sent.
 */

import { prisma, VISIBLE_USER } from "@polaris/db";
import { notify } from "@/lib/notifications/dispatch";
import { wordsFor } from "@/lib/notifications/notice-words";

/** How long one storage stays announced. In this process only: a second replica
 *  saying it again is a duplicate notice, not a missed one. */
const ANNOUNCE_EVERY_MS = 6 * 60 * 60 * 1000;

const announced = new Map<string, number>();

/** Where an administrator checks and re-points the upload storage. */
const UPLOADS_HREF = "/admin/uploads";

/**
 * Say that `name` would not open and what happened to the file instead.
 *
 * Never throws and never waits on its caller's behalf: an alert that could fail an
 * upload would be worse than no alert.
 */
export async function reportStorageUnreachable(storage: {
    id: string;
    name: string;
}): Promise<void> {
    const at = announced.get(storage.id);
    if (at !== undefined && Date.now() - at < ANNOUNCE_EVERY_MS) return;
    announced.set(storage.id, Date.now());
    try {
        const admins = await prisma.user.findMany({
            where: { isAdmin: true, ...VISIBLE_USER },
            select: { id: true }
        });
        await Promise.allSettled(
            admins.map(async (admin) => {
                const t = await wordsFor(admin.id, "notices");
                return notify({
                    userId: admin.id,
                    event: "storage.unreachable",
                    title: t("storage.unreachableTitle", { name: storage.name }),
                    body: t("storage.unreachableBody", { name: storage.name }),
                    audience: "admins",
                    level: "warning",
                    actionRequired: true,
                    href: UPLOADS_HREF
                });
            })
        );
    } catch (error) {
        // Nobody could be told this time; the next upload tries again.
        announced.delete(storage.id);
        console.error(
            "storage: could not tell the administrators a storage is unreachable:",
            error
        );
    }
}

/** The storage answered again, so the next time it goes away is news. */
export function storageAnswered(id: string): void {
    announced.delete(id);
}
