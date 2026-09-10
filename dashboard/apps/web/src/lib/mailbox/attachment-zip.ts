/**
 * Every file on a message, as one archive.
 *
 * A message with eleven scans on it is eleven downloads without this. The files
 * are streamed through the same zip writer Drive uses for a folder, one at a
 * time, each fetched from the mail server by the same owner-narrowed reader the
 * single download uses - so an archive is exactly the files somebody could have
 * saved one by one, and never anything else.
 *
 * Pictures the HTML draws by Content-Id are left out, as they are from the list
 * under the message: they are part of how the message looks, not files anybody
 * attached.
 */

import { prisma } from "@polaris/db";
import { MailAccessError } from "./access";
import { readAttachment } from "./messages";
import type { ZipSource } from "@/lib/zip-stream";

/** What an archive of one message holds, before any byte is read. */
export interface AttachmentZipPlan {
    /** The name the archive is saved as. */
    readonly archiveName: string;
    readonly sentAt: Date;
    readonly files: readonly { id: string; entry: string; size: bigint }[];
}

/**
 * A file name that is safe as an archive entry.
 *
 * A name from a stranger's message can carry a path - `../../.bashrc`, `C:\x`,
 * a leading slash - and an extractor that honours it writes outside the folder
 * somebody chose. So separators become spaces, control characters go, a name of
 * only dots is no name, and what is left is trimmed and bounded.
 */
export function safeEntryName(name: string): string {
    const cleaned = name
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[\\/:]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
    return /^\.*$/.test(cleaned) ? "attachment" : cleaned;
}

/**
 * The same names, made unique the way a file manager makes them unique.
 *
 * Two attachments called `scan.pdf` are common - a phone names every scan that -
 * and an archive with two entries of one name silently keeps only one of them
 * when it is opened. The second becomes `scan (2).pdf`, compared without regard
 * to case because the file systems it lands on mostly do not regard it either.
 */
export function uniqueEntryNames(names: readonly string[]): string[] {
    const taken = new Set<string>();
    return names.map((raw) => {
        const name = safeEntryName(raw);
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot) : "";
        let candidate = name;
        for (let copy = 2; taken.has(candidate.toLowerCase()); copy += 1) {
            candidate = `${stem} (${copy})${extension}`;
        }
        taken.add(candidate.toLowerCase());
        return candidate;
    });
}

/** Which files an archive of this message holds, narrowed to its owner. Refused
 *  with the same answer whether the message is somebody else's or not there. */
export async function attachmentZipPlan(
    userId: string,
    messageId: string
): Promise<AttachmentZipPlan> {
    const message = await prisma.mailMessage.findFirst({
        where: { id: messageId, account: { userId } },
        select: {
            subject: true,
            sentAt: true,
            attachments: {
                where: { inline: false },
                select: { id: true, name: true, size: true },
                orderBy: { part: "asc" }
            }
        }
    });
    if (!message || message.attachments.length === 0) {
        throw new MailAccessError("That message has no files to save.");
    }
    const entries = uniqueEntryNames(message.attachments.map((file) => file.name));
    const subject = safeEntryName(message.subject).slice(0, 80);
    return {
        archiveName: `${subject && subject !== "attachment" ? subject : "attachments"}.zip`,
        sentAt: message.sentAt,
        files: message.attachments.map((file, index) => ({
            id: file.id,
            entry: entries[index] ?? "attachment",
            size: file.size
        }))
    };
}

/** The archive's members, each read from the mail server only when the writer
 *  reaches it, so at most one file is held at a time. */
export async function* attachmentZipSources(
    userId: string,
    plan: AttachmentZipPlan
): AsyncGenerator<ZipSource> {
    for (const file of plan.files) {
        yield {
            name: file.entry,
            kind: "file",
            size: file.size,
            mtime: plan.sentAt,
            body: async () => {
                const read = await readAttachment(userId, file.id);
                return new Blob([new Uint8Array(read.bytes)]).stream();
            }
        };
    }
}
