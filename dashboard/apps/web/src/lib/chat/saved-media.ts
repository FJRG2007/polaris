/**
 * Pictures somebody kept.
 *
 * A GIF that made a room laugh is a GIF that will be sent again, and hunting for
 * it by scrolling back through a channel is the version of that everybody has
 * done and nobody enjoys. Keeping one puts it in the picker, beside the search
 * that found it the first time.
 *
 * Two things can be kept and they are stored the same way, behind a prefix:
 *
 *   `attachment:<id>` - already written to this Polaris. Sending it again copies
 *      the bytes into the new conversation rather than pointing a second row at
 *      the same file, because deleting the first message would otherwise take
 *      the picture out from under the second.
 *   `https://...`     - a picture that was posted as a link. Sending it goes
 *      through the same fetch every remote picture does, so the address is
 *      checked again at the moment it is used rather than trusted because it was
 *      once seen in a message.
 *
 * What is kept is not a permission. Somebody who saved a picture from a channel
 * they were later removed from keeps their copy of it, which is what "saved"
 * means everywhere - and the picture was already on their screen.
 */

import { send } from "./messages";
import { prisma } from "@polaris/db";
import { ChatAccessError, requireChannel, requirePostable, type ChatActor } from "./access";
import { readAttachment, storeAttachment, type StoredAttachment } from "./attachments";

/** The prefix that says a source is already stored here. */
const ATTACHMENT = "attachment:";

/** How many one person may keep. Generous, and a bound: this is a list a browser
 *  can add to, and a list a browser can add to without limit is a table one
 *  browser can fill. */
export const MAX_SAVED_MEDIA = 200;

/** One kept picture, as the picker draws it. */
export interface SavedMediaView {
    readonly id: string;
    readonly source: string;
    readonly name: string;
    /** Where the picker points an `img` at. Always an address on this Polaris
     *  for a stored one, so the picker never asks another site for anything. */
    readonly src: string;
}

/** Keep one. Doing it twice is not an error - it is somebody pressing a star
 *  they could not tell was already on. */
export async function saveMedia(
    actor: ChatActor,
    source: string,
    name = ""
): Promise<SavedMediaView> {
    const cleaned = await validate(actor, source);

    const kept = await prisma.chatSavedMedia.count({ where: { userId: actor.id } });
    const existing = await prisma.chatSavedMedia.findUnique({
        where: { userId_source: { userId: actor.id, source: cleaned } },
        select: { id: true, source: true, name: true }
    });
    if (existing) return view(existing);
    if (kept >= MAX_SAVED_MEDIA) {
        throw new ChatAccessError(`You can keep ${MAX_SAVED_MEDIA} pictures. Remove one first.`);
    }

    const row = await prisma.chatSavedMedia.create({
        data: { userId: actor.id, source: cleaned, name: name.slice(0, 200) },
        select: { id: true, source: true, name: true }
    });
    return view(row);
}

/** Stop keeping one, by what it is rather than by its row - the star is on the
 *  picture, and the picture is what the caller has. */
export async function unsaveMedia(actor: ChatActor, source: string): Promise<void> {
    await prisma.chatSavedMedia.deleteMany({
        where: { userId: actor.id, source: source.trim() }
    });
}

/** What this person has kept, newest first. */
export async function listSavedMedia(actor: ChatActor): Promise<readonly SavedMediaView[]> {
    const rows = await prisma.chatSavedMedia.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: "desc" },
        take: MAX_SAVED_MEDIA,
        select: { id: true, source: true, name: true }
    });
    return rows.map(view);
}

/** Which of these this person has kept, so a star can be drawn on the right
 *  ones without asking per picture. */
export async function savedSources(
    actor: ChatActor,
    sources: readonly string[]
): Promise<Set<string>> {
    const wanted = [...new Set(sources)].slice(0, 200);
    if (wanted.length === 0) return new Set();
    const rows = await prisma.chatSavedMedia.findMany({
        where: { userId: actor.id, source: { in: wanted } },
        select: { source: true }
    });
    return new Set(rows.map((row) => row.source));
}

/**
 * Send a kept picture into a conversation.
 *
 * A stored one is copied rather than referenced: a second row pointing at the
 * same file would mean deleting either message takes the picture out of both.
 * The bytes of a GIF are small and the alternative is a bug that only appears
 * when somebody tidies up.
 */
export async function sendSavedMedia(
    actor: ChatActor,
    channelId: string,
    savedId: string,
    /** What this one answers, or carries out of another room, when it was
     *  chosen with the composer's bar up. */
    quote: { readonly messageId: string; readonly forwarded: boolean } | null = null
): Promise<{ messageId: string } | { remote: string }> {
    await requirePostable(actor, channelId);

    const saved = await prisma.chatSavedMedia.findFirst({
        where: { id: savedId, userId: actor.id },
        select: { source: true, name: true }
    });
    if (!saved) throw new ChatAccessError("That is not one of yours");
    // A remote address is handed back rather than fetched here, so it goes
    // through the same guard every remote picture goes through - checked at the
    // moment it is used rather than trusted because it was once in a message.
    if (!saved.source.startsWith(ATTACHMENT)) return { remote: saved.source };

    const bytes = await readAttachment(saved.source.slice(ATTACHMENT.length));
    if (!bytes) throw new ChatAccessError("That picture is no longer stored here");

    const stored: StoredAttachment = await storeAttachment(channelId, {
        name: bytes.name,
        type: bytes.contentType,
        bytes: bytes.bytes
    });
    // A body of one space: the schema refuses an empty one, and what this
    // message says is said by the picture under it.
    return {
        messageId: await send(actor, { channelId, body: " ", parentId: null }, [stored], quote)
    };
}

/** Whether a saved thing is one already stored here. */
export function isStoredSource(source: string): boolean {
    return source.startsWith(ATTACHMENT);
}

/** The remote address behind a saved thing, or null when it is a stored one. */
export function remoteSource(source: string): string | null {
    return source.startsWith(ATTACHMENT) ? null : source;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * What may be kept, and the check that it is this reader's to keep.
 *
 * A stored picture is proved by the conversation it is in: an attachment id from
 * a browser is a request, and without this somebody could keep - and then
 * re-send - a file from a channel they have never been in.
 */
async function validate(actor: ChatActor, source: string): Promise<string> {
    const cleaned = source.trim();
    if (!cleaned || cleaned.length > 2048) throw new ChatAccessError("That cannot be kept");

    if (cleaned.startsWith(ATTACHMENT)) {
        const attachmentId = cleaned.slice(ATTACHMENT.length);
        const attachment = await prisma.chatAttachment.findUnique({
            where: { id: attachmentId },
            select: { message: { select: { channelId: true } } }
        });
        if (!attachment) throw new ChatAccessError("That picture is gone");
        // Read access, not post access: keeping something is reading it again.
        await requireChannel(actor, attachment.message.channelId);
        return cleaned;
    }

    // Only the web, and never a scheme that is a payload rather than an address.
    let url: URL;
    try {
        url = new URL(cleaned);
    } catch {
        throw new ChatAccessError("That is not an address");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ChatAccessError("That is not an address");
    }
    return url.href;
}

function view(row: { id: string; source: string; name: string }): SavedMediaView {
    return {
        id: row.id,
        source: row.source,
        name: row.name,
        src: row.source.startsWith(ATTACHMENT)
            ? `/api/chat/attachments/${row.source.slice(ATTACHMENT.length)}`
            : row.source
    };
}
