/**
 * Media auto-download (ledger row 5): whose pictures load on their own for one
 * reader, and whose wait behind a "Load" button showing their size and type.
 *
 * Prior art: WhatsApp's "Media auto-download" settings, which choose per kind
 * what downloads by itself, and its Advanced Chat Privacy, which stops
 * auto-saving. Here only pictures and video stills load on their own at all:
 * a video's bytes, a recording and a document already wait for somebody to
 * press play or open them (`VideoPreview`, `VoiceNote` with `preload="none"`,
 * `SentFile`), so one choice covers everything that would otherwise load.
 *
 * The reader's own choice (`UserPrivacy.chatAutoDownload`) wins; somebody who
 * never chose gets the instance's (`moderation-policy.ts`), which defaults to
 * everything - what every account had before. "contacts" is friends,
 * colleagues and the reader themselves, the same circle that may ring them.
 */

import { prisma } from "@polaris/db";
import { moderationPolicy } from "./moderation-policy";
import { colleaguesAmong } from "@/lib/privacy-service";
import { AUTO_DOWNLOAD_CHOICES, type AutoDownload } from "./moderation-policy-rules";

/** Pure: the choice that applies, from the stored one and the instance's. */
export function resolveAutoDownload(stored: string | null | undefined, instance: AutoDownload): AutoDownload {
    return (AUTO_DOWNLOAD_CHOICES as readonly string[]).includes(stored ?? "") ? (stored as AutoDownload) : instance;
}

/** The reader's stored choice, null when they never chose. */
export async function storedAutoDownload(userId: string): Promise<AutoDownload | null> {
    const row = await prisma.userPrivacy.findUnique({
        where: { userId },
        select: { chatAutoDownload: true }
    });
    const value = row?.chatAutoDownload ?? null;
    return (AUTO_DOWNLOAD_CHOICES as readonly string[]).includes(value ?? "") ? (value as AutoDownload) : null;
}

/**
 * Of these authors, whose pictures load on their own for this reader: "all"
 * for everybody's, authorless messages (a webhook, a notice) included.
 * Asked once per page of messages: two small queries at most.
 */
export async function autoLoadAuthors(
    readerId: string,
    authorIds: readonly string[]
): Promise<"all" | Set<string>> {
    const ids = [...new Set(authorIds)];
    const [stored, policy] = await Promise.all([storedAutoDownload(readerId), moderationPolicy()]);
    const choice = resolveAutoDownload(stored, policy.autoDownload);
    if (choice === "all") return "all";
    const loads = new Set(ids.filter((id) => id === readerId));
    if (choice === "none" || ids.length === loads.size) return loads;
    const others = ids.filter((id) => id !== readerId);
    const [friends, colleagues] = await Promise.all([
        prisma.friendship.findMany({
            where: {
                status: "accepted",
                OR: [
                    { requesterId: readerId, addresseeId: { in: others } },
                    { addresseeId: readerId, requesterId: { in: others } }
                ]
            },
            select: { requesterId: true, addresseeId: true }
        }),
        colleaguesAmong(readerId, others)
    ]);
    for (const row of friends) loads.add(row.requesterId === readerId ? row.addresseeId : row.requesterId);
    for (const id of colleagues) loads.add(id);
    return loads;
}
