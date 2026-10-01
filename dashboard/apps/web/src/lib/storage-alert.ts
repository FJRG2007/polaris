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
 *
 * A storage on the local network is looked for before the notice goes out, and
 * the notice says what that found: that it is off or unplugged, or which device
 * answers instead. One that moved to another address is followed, and that is a
 * notice of its own (`reportStorageMoved`).
 */

import { prisma, VISIBLE_USER } from "@polaris/db";
import { notify } from "@/lib/notifications/dispatch";
import { wordsFor } from "@/lib/notifications/notice-words";
import { withTimeout } from "@polaris/core";

/** How long one storage stays announced. In this process only: a second replica
 *  saying it again is a duplicate notice, not a missed one. */
const ANNOUNCE_EVERY_MS = 6 * 60 * 60 * 1000;

const announced = new Map<string, number>();

/** Where an administrator checks and re-points the upload storage. */
const UPLOADS_HREF = "/admin/uploads";

/** How long the search for a storage that stopped answering may hold the notice.
 *  The notice is worth more with the answer in it, and nobody is waiting on it. */
const SEARCH_WAIT_MS = 75_000;

/**
 * Say that `name` would not open and what happened to the file instead - and,
 * since Polaris has just looked for it on the network, what that found.
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
        const outcome = await lookFor(storage.id);
        // Found and followed: that is its own notice, sent by the search, and
        // the storage is back. Nothing is unreachable any more.
        if (outcome?.kind === "followed") {
            announced.delete(storage.id);
            return;
        }
        await toAdmins(async (t) => ({
            event: "storage.unreachable",
            title: t("storage.unreachableTitle", { name: storage.name }),
            body: unreachableBody(t, storage.name, outcome),
            level: "warning"
        }));
    } catch (error) {
        // Nobody could be told this time; the next upload tries again.
        announced.delete(storage.id);
        console.error(
            "storage: could not tell the administrators a storage is unreachable:",
            error
        );
    }
}

type Words = Awaited<ReturnType<typeof wordsFor<"notices">>>;
type Outcome = import("@/lib/storage-whereabouts/follow").SearchOutcome;

/** The search's answer, or null when there is none to give: not a storage it
 *  can look for, or a search that did not finish in time. */
async function lookFor(id: string): Promise<Outcome | null> {
    try {
        const { searchFor } = await import("@/lib/storage-whereabouts/follow");
        return await withTimeout(searchFor(id), SEARCH_WAIT_MS, "the search took too long");
    } catch {
        return null;
    }
}

/** The body of the unreachable notice, with what the search found in it. */
export function unreachableBody(t: Words, name: string, outcome: Outcome | null): string {
    if (outcome?.kind === "gone") return t("storage.unreachableGone", { name });
    if (outcome?.kind === "answering")
        return t("storage.unreachableAnswering", { name, address: outcome.address });
    if (outcome?.kind === "impostor") {
        return t("storage.unreachableImpostor", {
            name,
            address: outcome.address,
            device: outcome.label ?? outcome.address
        });
    }
    if (outcome?.kind === "candidates") {
        const first = outcome.candidates[0]!;
        return t("storage.unreachableCandidates", {
            name,
            address: first.address,
            device: first.label ?? first.address,
            count: outcome.candidates.length
        });
    }
    return t("storage.unreachableBody", { name });
}

/**
 * Say that a storage's device moved and Polaris now dials it where it went - and
 * ask for the one thing Polaris cannot do from here: a reservation in the router,
 * so the lease does not move again. Named by hardware address, which is what a
 * router's reservation screen lists.
 */
export async function reportStorageMoved(storage: {
    id: string;
    name: string;
    from: string;
    to: string;
    mac: string | null;
}): Promise<void> {
    storageAnswered(storage.id);
    try {
        await toAdmins(async (t) => ({
            event: "storage.moved",
            title: t("storage.movedTitle", { name: storage.name }),
            body: storage.mac
                ? t("storage.movedBody", { ...storage, mac: storage.mac })
                : t("storage.movedBodyNoMac", storage),
            level: "info"
        }));
    } catch (error) {
        console.error("storage: could not tell the administrators a storage moved:", error);
    }
}

/** One notice to every administrator, in each one's language. */
async function toAdmins(
    say: (t: Words) => Promise<{
        event: "storage.unreachable" | "storage.moved";
        title: string;
        body: string;
        level: "warning" | "info";
    }>
): Promise<void> {
    const admins = await prisma.user.findMany({
        where: { isAdmin: true, ...VISIBLE_USER },
        select: { id: true }
    });
    await Promise.allSettled(
        admins.map(async (admin) => {
            const words = await say(await wordsFor(admin.id, "notices"));
            return notify({
                userId: admin.id,
                event: words.event,
                title: words.title,
                body: words.body,
                audience: "admins",
                level: words.level,
                actionRequired: true,
                href: UPLOADS_HREF
            });
        })
    );
}

/** The storage answered again, so the next time it goes away is news. */
export function storageAnswered(id: string): void {
    announced.delete(id);
}
