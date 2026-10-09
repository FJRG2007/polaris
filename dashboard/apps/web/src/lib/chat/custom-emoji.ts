/**
 * A space's own emoji: keeping them, and keeping them in their space.
 *
 * Discord's model, decided once and held everywhere: an emoji belongs to one
 * space and is only usable there. Not in a direct message, not in another space,
 * not under a task. The screens only offer it where it belongs, and that is a
 * courtesy - the rule is enforced here, on every write that can carry one: a
 * message (`confineCustomEmoji`) and a reaction (`reactionEmoji`).
 *
 * Who may add, rename and remove one is whoever runs the space - its owner and
 * its administrators, Discord's "manage expressions" on the role model this
 * space already has. Everybody who reaches the space may use them.
 *
 * The bytes travel the way a chat attachment's do: `placeFile` into the storage
 * chat writes to, the connection recorded per row, read back through
 * `readStored`. Under a root of their own (`polaris/chat-emoji/<space>`) rather
 * than inside the attachments' one, because the attachment sweep removes every
 * folder there that is not named after a conversation.
 *
 * Server-only.
 */

import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { publishChatChange } from "./live";
import { imageTypeOfBytes } from "@/lib/mime";
import { prisma, type Prisma } from "@polaris/db";
import { driverForTarget, LOCAL_TARGET, placeFile } from "@/lib/storage-target";
import { CHAT_LOCAL_FOLDER, chatTarget, readStored, removeStoredFiles } from "./attachments";
import {
    ChatRuleError,
    requireSpace,
    spaceAccess,
    type ChatActor,
    type ChatErrorText
} from "./access";

/** Where the files go inside whichever storage chat writes to. */
export const EMOJI_ROOT = "polaris/chat-emoji";

/** The file extension stored for each type, so a NAS browser can open one. */
const EXTENSION: Record<core.CustomEmojiType, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp"
};

/** What sharp calls each format, against what the first bytes said. */
const SHARP_FORMAT: Record<core.CustomEmojiType, string> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/gif": "gif",
    "image/webp": "webp"
};

/** One emoji, as the screens draw it. */
export interface SpaceEmojiView {
    readonly id: string;
    readonly name: string;
    readonly animated: boolean;
    /** Who uploaded it, or null once that account is gone. */
    readonly uploaderId: string | null;
    readonly uploaderName: string | null;
    readonly createdAt: string;
}

/** Everything a space has, and whether this reader may change it. */
export interface SpaceEmojiList {
    readonly emoji: readonly SpaceEmojiView[];
    /** Whether this reader may add, rename and remove them. */
    readonly manages: boolean;
}

const VIEW_SELECT = {
    id: true,
    name: true,
    animated: true,
    uploaderId: true,
    createdAt: true,
    uploader: { select: { name: true } }
} satisfies Prisma.ChatSpaceEmojiSelect;

type ViewRow = Prisma.ChatSpaceEmojiGetPayload<{ select: typeof VIEW_SELECT }>;

function view(row: ViewRow): SpaceEmojiView {
    return {
        id: row.id,
        name: row.name,
        animated: row.animated,
        uploaderId: row.uploaderId,
        uploaderName: row.uploader?.name ?? null,
        createdAt: row.createdAt.toISOString()
    };
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/** Why a file is refused, as a word the screen turns into a sentence. */
export type EmojiFileProblem = "empty" | "size" | "type" | "dimensions" | "unreadable";

/** What a file turned out to be, once its bytes were read. */
export type InspectedEmoji =
    | {
          readonly ok: true;
          readonly mime: core.CustomEmojiType;
          readonly animated: boolean;
          readonly width: number;
          readonly height: number;
      }
    | { readonly ok: false; readonly problem: EmojiFileProblem };

/**
 * What an uploaded file really is, from its bytes alone.
 *
 * The extension and the type the browser declared are both the uploader's word
 * for it and neither is read. The first bytes say which of the four formats it
 * is; then the whole picture is decoded, which is what proves it is one rather
 * than a header glued to something else, and what gives the real size and the
 * frame count. Moving or still is that frame count: a GIF of one frame is a
 * still and takes a still's slot.
 */
export async function inspectEmojiFile(bytes: Uint8Array): Promise<InspectedEmoji> {
    if (bytes.length === 0) return { ok: false, problem: "empty" };
    if (bytes.length > core.CUSTOM_EMOJI_MAX_BYTES) return { ok: false, problem: "size" };
    const mime = imageTypeOfBytes(bytes) as core.CustomEmojiType | undefined;
    if (!mime || !core.CUSTOM_EMOJI_TYPES.includes(mime)) return { ok: false, problem: "type" };

    try {
        const { default: sharp } = await import("sharp");
        // Bounded before anything is decoded: a small file can still declare a
        // picture of millions of pixels, and that is the decoder's memory.
        const limitInputPixels = core.CUSTOM_EMOJI_MAX_SIDE * core.CUSTOM_EMOJI_MAX_SIDE * 64;
        const image = sharp(bytes, { animated: true, limitInputPixels });
        const meta = await image.metadata();
        if (meta.format !== SHARP_FORMAT[mime]) return { ok: false, problem: "type" };
        const width = meta.width ?? 0;
        const height = meta.pageHeight ?? meta.height ?? 0;
        if (width < 1 || height < 1) return { ok: false, problem: "unreadable" };
        if (width > core.CUSTOM_EMOJI_MAX_SIDE || height > core.CUSTOM_EMOJI_MAX_SIDE) {
            return { ok: false, problem: "dimensions" };
        }
        // Every frame, so a file that is only a valid header is refused here
        // rather than drawn as a broken picture in every message that uses it.
        await image.stats();
        const frames = meta.pages ?? 1;
        const animated = (mime === "image/gif" || mime === "image/webp") && frames > 1;
        return { ok: true, mime, animated, width, height };
    } catch {
        return { ok: false, problem: "unreadable" };
    }
}

const FILE_REFUSAL: Record<EmojiFileProblem, ChatErrorText> = {
    empty: { key: "errors.emojiFileEmpty" },
    size: { key: "errors.emojiFileSize" },
    type: { key: "errors.emojiFileType" },
    dimensions: { key: "errors.emojiFileDimensions" },
    unreadable: { key: "errors.emojiFileUnreadable" }
};

const NAME_REFUSAL: Record<core.CustomEmojiNameProblem, ChatErrorText> = {
    short: { key: "errors.emojiNameShort" },
    long: { key: "errors.emojiNameLong" },
    characters: { key: "errors.emojiNameCharacters" },
    edges: { key: "errors.emojiNameEdges" }
};

/** The name, normalized, or a refusal saying what is wrong with it. */
function checkedName(raw: string): string {
    const name = core.normalizeEmojiName(raw);
    const problem = core.emojiNameProblem(name);
    if (problem) throw new ChatRuleError(NAME_REFUSAL[problem]);
    return name;
}

function isUniqueViolation(caught: unknown): boolean {
    return (
        typeof caught === "object" &&
        caught !== null &&
        (caught as Prisma.PrismaClientKnownRequestError).code === "P2002"
    );
}

// ---------------------------------------------------------------------------
// The list and its changes
// ---------------------------------------------------------------------------

/** A space's emoji, oldest first - the order they were added, which is the
 *  order the picker and the settings page show. */
export async function listSpaceEmoji(actor: ChatActor, spaceId: string): Promise<SpaceEmojiList> {
    const access = await requireSpace(actor, spaceId);
    const rows = await prisma.chatSpaceEmoji.findMany({
        where: { spaceId },
        orderBy: { createdAt: "asc" },
        // The two slot ceilings together; a hand-edited database cannot make
        // this an unbounded read.
        take: core.CUSTOM_EMOJI_SLOTS * 2,
        select: VIEW_SELECT
    });
    return { emoji: rows.map(view), manages: access !== "member" };
}

/**
 * Add one.
 *
 * The file is checked and written first and the row last, inside a transaction
 * that holds the space's row for the moment it takes to count. Two uploads
 * racing for the fiftieth slot are then one after the other rather than both
 * seeing forty-nine: the second one counts fifty and is refused. A refusal at
 * that point takes the file it already wrote back off the disk.
 */
export async function uploadSpaceEmoji(
    actor: ChatActor,
    spaceId: string,
    input: { readonly name: string; readonly bytes: Uint8Array }
): Promise<SpaceEmojiView> {
    await requireSpace(actor, spaceId, "admin");
    const name = checkedName(input.name);
    const inspected = await inspectEmojiFile(input.bytes);
    if (!inspected.ok) throw new ChatRuleError(FILE_REFUSAL[inspected.problem]);

    const folder = `${EMOJI_ROOT}/${spaceId}`;
    const path = `${folder}/${crypto.randomUUID()}${EXTENSION[inspected.mime]}`;
    let connectionId: string | null;
    try {
        const placed = await placeFile({
            target: await chatTarget(),
            localFolder: CHAT_LOCAL_FOLDER,
            folder,
            path,
            bytes: input.bytes,
            mime: inspected.mime,
            what: "emoji"
        });
        connectionId = placed.targetId === LOCAL_TARGET ? null : placed.targetId;
    } catch (error) {
        console.error("chat: an emoji could not be stored:", error);
        throw new ChatRuleError({ key: "errors.emojiNotStored" });
    }

    try {
        const row = await prisma.$transaction(async (tx) => {
            // The space's row, held until this transaction ends: every other
            // upload to the same space waits here, so the count below is the
            // count when the row is written. Postgres only - the local SQLite
            // database has one writer at a time and no row locks to ask for.
            if (loadEnv().POLARIS_DB_PROVIDER === "postgresql") {
                await tx.$queryRaw`SELECT "id" FROM "ChatSpace" WHERE "id" = ${spaceId}::uuid FOR UPDATE`;
            }
            const used = await tx.chatSpaceEmoji.count({
                where: { spaceId, animated: inspected.animated }
            });
            if (used >= core.CUSTOM_EMOJI_SLOTS) {
                throw new ChatRuleError({
                    key: inspected.animated ? "errors.emojiSlotsAnimated" : "errors.emojiSlotsStatic"
                });
            }
            return tx.chatSpaceEmoji.create({
                data: {
                    spaceId,
                    name,
                    nameKey: core.customEmojiNameKey(name),
                    animated: inspected.animated,
                    mime: inspected.mime,
                    size: input.bytes.length,
                    width: inspected.width,
                    height: inspected.height,
                    connectionId,
                    path,
                    uploaderId: actor.id
                },
                select: VIEW_SELECT
            });
        });
        await announce(actor, spaceId);
        return view(row);
    } catch (caught) {
        await removeStoredFiles([{ connectionId, path }]);
        if (isUniqueViolation(caught)) throw new ChatRuleError({ key: "errors.emojiNameTaken" });
        throw caught;
    }
}

/** The space one belongs to, for whoever runs it, or a refusal. */
async function managed(actor: ChatActor, emojiId: string) {
    const row = await prisma.chatSpaceEmoji.findUnique({
        where: { id: emojiId },
        select: { id: true, spaceId: true, connectionId: true, path: true, name: true }
    });
    if (!row) throw new ChatRuleError({ key: "errors.emojiGone" });
    await requireSpace(actor, row.spaceId, "admin");
    return row;
}

/** Give one a new name. Every message already using it follows, since they
 *  point at it by id. */
export async function renameSpaceEmoji(
    actor: ChatActor,
    input: core.CustomEmojiRenameInput
): Promise<SpaceEmojiView> {
    const row = await managed(actor, input.emojiId);
    const name = checkedName(input.name);
    try {
        const updated = await prisma.chatSpaceEmoji.update({
            where: { id: row.id },
            data: { name, nameKey: core.customEmojiNameKey(name) },
            select: VIEW_SELECT
        });
        await announce(actor, row.spaceId);
        return view(updated);
    } catch (caught) {
        if (isUniqueViolation(caught)) throw new ChatRuleError({ key: "errors.emojiNameTaken" });
        throw caught;
    }
}

/** Take one away. Messages that used it keep its name, as text. */
export async function deleteSpaceEmoji(actor: ChatActor, emojiId: string): Promise<void> {
    const row = await managed(actor, emojiId);
    await prisma.chatSpaceEmoji.delete({ where: { id: row.id } });
    await removeStoredFiles([row]);
    await announce(actor, row.spaceId);
}

/**
 * Tell the space's open tabs the list changed.
 *
 * The frame carries the space and the rooms in it, never an emoji: a tab that
 * reaches one of those rooms asks for the list again, through the same check
 * that drew it the first time.
 */
async function announce(actor: ChatActor, spaceId: string): Promise<void> {
    const channels = await prisma.chatChannel.findMany({ where: { spaceId }, select: { id: true } });
    publishChatChange({
        kind: "emoji",
        spaceId,
        actorId: actor.id,
        channels: channels.map((channel) => channel.id)
    });
}

/**
 * Every file a space's emoji keep, gone before the space is.
 *
 * Deleting a space cascades the rows away, and a cascade takes rows, not bytes.
 * Never throws: a picture the storage will not give up must not stop a space
 * being deleted - the sweep (`tidyEmojiStorage`) finds it later.
 */
export async function discardSpaceEmoji(spaceId: string): Promise<void> {
    const rows = await prisma.chatSpaceEmoji
        .findMany({ where: { spaceId }, select: { connectionId: true, path: true } })
        .catch(() => []);
    await removeStoredFiles(rows).catch(() => undefined);
}

/**
 * Folders under the emoji root whose space no longer exists.
 *
 * A space can go without `deleteSpace` being the one to delete it - its owner's
 * account or its organization being removed cascades it away - and then nothing
 * took its emoji's files with it. Deliberately narrow, like the attachments'
 * sweep: a folder goes only when no space answers to its name, never because a
 * row does not happen to point at a file inside it.
 */
export async function tidyEmojiStorage(): Promise<{ removed: number; failed: number }> {
    const [stored, spaces, current] = await Promise.all([
        prisma.chatSpaceEmoji.findMany({ select: { connectionId: true }, distinct: ["connectionId"] }),
        prisma.chatSpace.findMany({ select: { id: true } }),
        chatTarget()
    ]);
    const live = new Set(spaces.map((space) => space.id));
    const targets = new Set(stored.map((row) => row.connectionId ?? LOCAL_TARGET));
    targets.add(current.id);

    let removed = 0;
    let failed = 0;
    for (const target of targets) {
        const driver = await driverForTarget(target, CHAT_LOCAL_FOLDER).catch(() => null);
        if (!driver) {
            failed += 1;
            continue;
        }
        try {
            let cursor: string | undefined;
            do {
                const page = await driver
                    .list(EMOJI_ROOT, cursor ? { cursor } : undefined)
                    .catch(() => null);
                if (!page) break;
                cursor = page.nextCursor;
                for (const entry of page.entries) {
                    if (entry.kind !== "dir" || live.has(entry.name)) continue;
                    await driver
                        .delete(entry.path, { recursive: true })
                        .then(() => {
                            removed += 1;
                        })
                        .catch(() => {
                            failed += 1;
                        });
                }
            } while (cursor);
        } finally {
            await driver.dispose().catch(() => undefined);
        }
    }
    return { removed, failed };
}

// ---------------------------------------------------------------------------
// Reading one
// ---------------------------------------------------------------------------

/**
 * One emoji's picture, for somebody who reaches its space - and null for
 * everybody else, which is the same answer as "there is no such emoji".
 */
export async function readSpaceEmoji(
    actor: ChatActor,
    emojiId: string
): Promise<{ readonly mime: string; readonly bytes: Uint8Array } | null> {
    const row = await prisma.chatSpaceEmoji.findUnique({
        where: { id: emojiId },
        select: { spaceId: true, connectionId: true, path: true, mime: true }
    });
    if (!row) return null;
    if (!(await spaceAccess(actor, row.spaceId))) return null;
    const bytes = await readStored(row.connectionId, row.path, `emoji ${emojiId}`);
    return bytes ? { mime: row.mime, bytes } : null;
}

// ---------------------------------------------------------------------------
// Keeping them in their space
// ---------------------------------------------------------------------------

/** The emoji of one space among the given ids, by id. */
async function ofSpace(spaceId: string | null, ids: readonly string[]) {
    if (!spaceId || ids.length === 0) return new Map<string, core.CustomEmojiRef>();
    const rows = await prisma.chatSpaceEmoji.findMany({
        where: { spaceId, id: { in: [...new Set(ids)] } },
        select: { id: true, name: true, animated: true }
    });
    return new Map(rows.map((row) => [row.id, row]));
}

/**
 * A message's text with every emoji it may not carry turned into its name.
 *
 * What makes "only in its own space" true rather than a habit of the picker: a
 * token pasted from another space, typed by hand, sent through the API, or left
 * pointing at an emoji deleted since lands as the plain `:name:` it would have
 * been drawn as anyway. The ones that do belong are written back with their
 * current name and kind, so the stored text says what the space has today.
 *
 * @param spaceId - The conversation's space, or null for a direct message or a
 *   group, where no custom emoji is usable at all.
 */
export async function confineCustomEmoji(body: string, spaceId: string | null): Promise<string> {
    const refs = core.customEmojiRefs(body);
    if (refs.length === 0) return body;
    const allowed = await ofSpace(
        spaceId,
        refs.map((ref) => ref.id)
    );
    return core.replaceCustomEmoji(body, (ref) => {
        const found = allowed.get(ref.id);
        return found ? core.customEmojiToken(found) : core.customEmojiFallback(ref);
    });
}

/**
 * What a reaction stores, once it is checked against where the message is.
 *
 * An ordinary emoji is itself. A custom one has to belong to the space the
 * message was said in, and is stored in its current form; `removing` lets
 * somebody take back a reaction whose emoji has since been deleted, which is
 * the one thing still worth doing with it.
 */
export async function reactionEmoji(
    spaceId: string | null,
    emoji: string,
    removing: boolean
): Promise<{ readonly stored: string; readonly customId: string | null }> {
    const ref = core.parseCustomEmojiToken(emoji);
    if (!ref) return { stored: emoji, customId: null };
    const found = (await ofSpace(spaceId, [ref.id])).get(ref.id);
    if (found) return { stored: core.customEmojiToken(found), customId: ref.id };
    if (removing) return { stored: core.customEmojiToken(ref), customId: ref.id };
    throw new ChatRuleError({ key: "errors.emojiNotHere" });
}

