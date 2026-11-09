/**
 * Files attached to a prompt, carried into the session's working directory.
 *
 * The agent works on files, so a file it is given is a file it can open:
 * written into `.polaris/attachments/` inside the checkout (ignored by a
 * `.gitignore` of its own, so nothing the agent commits picks them up) and
 * named in the prompt. Pictures included - the agents read them by path.
 *
 * The bytes travel through the same command channel every steer uses, in
 * base64 slices small enough to be one argument, so nothing new has to exist on
 * the machine.
 */

import { prisma } from "@polaris/db";
import { readPolarAttachment } from "@/lib/polar/attachments";

/** Where they land, relative to the working directory. */
export const ATTACHMENTS_DIR = ".polaris/attachments";

/** The most one prompt carries in all. */
export const SESSION_ATTACHMENTS_MAX_BYTES = 10 * 1024 * 1024;

/** Raw bytes per command: 64 KiB of base64, well under one argument's limit. */
const CHUNK_BYTES = 48 * 1024;

/** A file name that is safe unquoted in a shell and on any file system. */
export function attachmentFileName(index: number, name: string): string {
    const safe = name
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^[.-]+/, "")
        .slice(-80);
    return `${index + 1}-${safe || "file"}`;
}

/** Where each file lands, in the order given. */
export function attachmentPaths(names: readonly string[]): string[] {
    return names.map((name, index) => `${ATTACHMENTS_DIR}/${attachmentFileName(index, name)}`);
}

/** The prompt, with the files it carries named for the agent. */
export function withAttachmentNote(text: string, paths: readonly string[]): string {
    if (paths.length === 0) return text;
    const list = paths.map((path) => `- ${path}`).join("\n");
    return `${text}\n\nAttached files (relative to the working directory):\n${list}`;
}

/**
 * The commands that write the files, in order. `workdir` is one of Polaris's
 * own working directories (it may start with `$HOME`, so it is double quoted).
 * The folder ends owned by whoever owns the working directory, so an agent that
 * runs as somebody else can still read and tidy it.
 */
export function attachmentCommands(
    workdir: string,
    files: ReadonlyArray<{ path: string; bytes: Uint8Array }>
): string[] {
    const cd = `cd "${workdir}"`;
    const out = [`${cd} && mkdir -p ${ATTACHMENTS_DIR} && printf '*\\n' > .polaris/.gitignore`];
    for (const file of files) {
        const buffer = Buffer.from(file.bytes);
        if (buffer.byteLength === 0) out.push(`${cd} && : > '${file.path}'`);
        for (let at = 0; at < buffer.byteLength; at += CHUNK_BYTES) {
            const slice = buffer.subarray(at, at + CHUNK_BYTES).toString("base64");
            const into = at === 0 ? ">" : ">>";
            out.push(`${cd} && printf %s '${slice}' | base64 -d ${into} '${file.path}'`);
        }
    }
    out.push(`${cd} && chown -R "$(stat -c %u:%g .)" .polaris 2>/dev/null || true`);
    return out;
}

export interface SessionAttachment {
    readonly id: string;
    readonly name: string;
    readonly path: string;
}

/**
 * The person's own uploads by id, with where each will land - or why they
 * cannot go: one that is not theirs (or is gone), or more bytes than a prompt
 * carries.
 */
export async function sessionAttachmentsFor(
    userId: string,
    ids: readonly string[]
): Promise<{ files: SessionAttachment[] } | { refusal: "missing" | "tooLarge" }> {
    if (ids.length === 0) return { files: [] };
    const rows = await prisma.polarAttachment.findMany({
        where: { id: { in: [...ids] }, userId },
        select: { id: true, name: true, size: true }
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const found = ids.flatMap((id) => {
        const row = byId.get(id);
        return row ? [row] : [];
    });
    if (found.length !== ids.length) return { refusal: "missing" };
    if (found.reduce((sum, row) => sum + row.size, 0) > SESSION_ATTACHMENTS_MAX_BYTES)
        return { refusal: "tooLarge" };
    const paths = attachmentPaths(found.map((row) => row.name));
    return {
        files: found.map((row, index) => ({
            id: row.id,
            name: row.name,
            path: paths[index] ?? ""
        }))
    };
}

/** The bytes of each, read back as their owner, bounded on the way. */
export async function attachmentBytes(
    userId: string,
    files: readonly SessionAttachment[]
): Promise<Array<{ path: string; bytes: Uint8Array }>> {
    const out: Array<{ path: string; bytes: Uint8Array }> = [];
    let budget = SESSION_ATTACHMENTS_MAX_BYTES;
    for (const file of files) {
        const stored = await readPolarAttachment(userId, file.id);
        if (!stored) throw new Error(`the file ${file.name} is no longer there`);
        const bytes = new Uint8Array(await new Response(stored.body).arrayBuffer());
        budget -= bytes.byteLength;
        if (budget < 0) throw new Error("the files are larger than a prompt carries");
        out.push({ path: file.path, bytes });
    }
    return out;
}
