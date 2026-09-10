/**
 * A service whose source is a folder somebody uploaded, rather than a repository.
 *
 * The folder arrives as a zip (the browser zips a dropped folder itself), is
 * unpacked into a scratch directory with every entry checked, and is kept as a
 * gzipped tar under the data volume - the same shape a clone is turned into, so a
 * deploy builds it with exactly the detection and builders a repository gets.
 * Only the newest upload is kept: redeploying builds what was uploaded last, and a
 * rollback runs a kept image, never an old source.
 *
 * Unpacking is where an upload could do harm, so it is strict: no absolute paths,
 * no parent steps, no links, a cap on the number of files and on the bytes they
 * unpack to (a small zip can expand to anything), and the folders nobody means to
 * deploy - `node_modules`, `.git` - left out.
 */

import { z } from "zod";
import JSZip from "jszip";
import { tmpdir } from "node:os";
import { prisma } from "@polaris/db";
import { Transform } from "node:stream";
import { randomUUID } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import type { BuildContext } from "@polaris/deploy";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { contextFromDirectory, type BuildCommands } from "@/lib/git-build-service";

/** A reason an upload was refused, worded for whoever sent it. Anything else that
 *  goes wrong is logged and answered with a generic sentence. */
export class SourceRefusal extends Error {}

/** The largest zip taken. */
export const MAX_SOURCE_ZIP = 200 * 1024 ** 2;

/** The most its files may unpack to, and how many there may be. */
export const MAX_SOURCE_BYTES = 1024 ** 3;
export const MAX_SOURCE_FILES = 50_000;

/** Folders left out wherever they appear: installed dependencies and history. */
const SKIPPED_FOLDERS = new Set(["node_modules", ".git", "__MACOSX"]);

/** What a service remembers about its uploaded source. */
export const uploadedSourceSchema = z.object({
    id: z.string().uuid(),
    name: z.string().max(200),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    uploadedAt: z.string()
});
export type UploadedSource = z.infer<typeof uploadedSourceSchema>;

/** The uploaded source a service's stored settings name, if any. */
export function uploadedSourceOf(sourceConfig: string | Record<string, unknown>): UploadedSource | null {
    let source: Record<string, unknown>;
    try {
        source = typeof sourceConfig === "string" ? (JSON.parse(sourceConfig) as Record<string, unknown>) : sourceConfig;
    } catch {
        return null;
    }
    const parsed = uploadedSourceSchema.safeParse(source.upload);
    return parsed.success ? parsed.data : null;
}

function sourcesDir(applicationId: string): string {
    return join(loadEnv().POLARIS_DATA_DIR, "deploy-sources", applicationId);
}

/** Where one upload of a service's source is kept. */
export function uploadedSourcePath(applicationId: string, uploadId: string): string {
    return join(sourcesDir(applicationId), `${uploadId}.tar.gz`);
}

/**
 * An entry's path as it will be written, or null when it must not be.
 *
 * Separators are made forward, a leading `./` dropped; anything absolute, with a
 * drive letter, with a parent step, a control character or an overlong name is
 * refused, and so is anything inside a folder that is left out.
 */
export function safeEntryPath(raw: string): string | null {
    const unified = raw.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
    if (!unified || unified.length > 1024) return null;
    if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return null;
    if ([...unified].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
    const segments = unified.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0 || segments.some((segment) => segment === ".." || segment === ".")) return null;
    if (segments.some((segment) => SKIPPED_FOLDERS.has(segment))) return null;
    if (segments[segments.length - 1] === ".DS_Store") return null;
    return segments.join("/");
}

/** Whether a zip entry is a symbolic link, by the unix mode it carries. */
function isLink(entry: JSZip.JSZipObject): boolean {
    const mode = typeof entry.unixPermissions === "string" ? Number.parseInt(entry.unixPermissions, 8) : entry.unixPermissions;
    return typeof mode === "number" && (mode & 0o170000) === 0o120000;
}

/**
 * The prefix every path shares when the zip holds one folder and nothing beside
 * it - the usual shape of a zipped folder - so the folder's contents become the
 * source root rather than one folder down.
 */
function sharedFolder(paths: readonly string[]): string {
    const first = paths[0]?.split("/")[0];
    if (!first || paths.some((path) => !path.startsWith(`${first}/`))) return "";
    return `${first}/`;
}

function run(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
        let said = "";
        child.stderr.on("data", (chunk: Buffer) => {
            if (said.length < 2000) said += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(said.trim() || `${command} exited with code ${code ?? -1}`))
        );
    });
}

/**
 * Unpack a zip into `dir`, checking every entry, and answer what was written.
 * Throws with the reason for the first thing that makes the upload unusable.
 */
export async function unpackSourceZip(zip: Buffer, dir: string): Promise<{ files: number; bytes: number }> {
    let archive: JSZip;
    try {
        archive = await JSZip.loadAsync(zip);
    } catch {
        throw new SourceRefusal("That is not a zip file.");
    }
    const entries = Object.values(archive.files).filter((entry) => !entry.dir && !isLink(entry));
    const named = entries.flatMap((entry) => {
        // jszip resolves `..` in `name` itself; the name as written is what decides.
        const path = safeEntryPath(entry.unsafeOriginalName ?? entry.name);
        return path ? [{ entry, path }] : [];
    });
    if (named.length === 0) throw new SourceRefusal("The upload has no files in it.");
    if (named.length > MAX_SOURCE_FILES) throw new SourceRefusal(`The upload has more than ${MAX_SOURCE_FILES} files.`);
    const prefix = sharedFolder(named.map((item) => item.path));
    let bytes = 0;
    for (const { entry, path } of named) {
        const relative = path.slice(prefix.length);
        if (!relative) continue;
        const target = join(dir, ...relative.split("/"));
        await mkdir(dirname(target), { recursive: true });
        const counted = new Transform({
            transform(chunk: Buffer, _encoding, done) {
                bytes += chunk.length;
                if (bytes > MAX_SOURCE_BYTES) {
                    done(new SourceRefusal(`The upload unpacks to more than ${MAX_SOURCE_BYTES / 1024 ** 3} GB.`));
                    return;
                }
                done(null, chunk);
            }
        });
        await pipeline(entry.nodeStream("nodebuffer"), counted, createWriteStream(target));
    }
    return { files: named.length, bytes };
}

/** Whether a Dockerfile sits at the source root, or at `root` inside it. */
async function hasDockerfile(dir: string, root: string): Promise<boolean> {
    const at = root ? join(dir, ...root.split("/")) : dir;
    return (await readdir(at).catch(() => [] as string[])).includes("Dockerfile");
}

/**
 * Take an uploaded zip as a service's source: unpack and check it, keep it as the
 * service's newest source, forget the one before, and answer what was kept. The
 * service builds with its Dockerfile when the upload has one at its root, and is
 * detected otherwise.
 */
export async function storeUploadedSource(
    applicationId: string,
    ownerId: string,
    zipFile: string,
    name: string
): Promise<UploadedSource> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { sourceType: true, sourceConfig: true }
    });
    if (!app) throw new Error("Application not found");
    if (app.sourceType === "image" || app.sourceType === "compose") {
        throw new SourceRefusal("This service runs an image. Create a new service for an uploaded folder.");
    }
    const source = JSON.parse(app.sourceConfig || "{}") as Record<string, unknown>;
    if (typeof source.repoUrl === "string" && source.repoUrl) {
        throw new SourceRefusal("This service builds from a repository. Create a new service for an uploaded folder.");
    }
    const zip = await readFile(zipFile);
    const dir = await mkdtemp(join(tmpdir(), "polaris-upload-"));
    try {
        const counted = await unpackSourceZip(zip, dir);
        const root = typeof source.rootDirectory === "string" ? source.rootDirectory.replace(/^\/+|\/+$/g, "") : "";
        const dockerfile = await hasDockerfile(dir, root);
        const upload: UploadedSource = {
            id: randomUUID(),
            name: name.trim().slice(0, 200) || "upload",
            files: counted.files,
            bytes: counted.bytes,
            uploadedAt: new Date().toISOString()
        };
        const kept = uploadedSourcePath(applicationId, upload.id);
        await mkdir(dirname(kept), { recursive: true });
        await run("tar", ["-czf", kept, "-C", dir, "."]);
        const previous = uploadedSourceOf(source);
        await prisma.application.update({
            where: { id: applicationId },
            data: {
                sourceType: dockerfile ? "dockerfile" : "nixpacks",
                sourceConfig: JSON.stringify({ ...source, upload })
            }
        });
        if (previous && previous.id !== upload.id) {
            await rm(uploadedSourcePath(applicationId, previous.id), { force: true });
        }
        return upload;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * A build-context factory for an uploaded source: each call unpacks the kept
 * archive into a fresh directory and hands it to the same detection a clone goes
 * through.
 */
export function uploadedBuildContext(
    archive: string,
    onOutput: (chunk: Buffer) => void,
    commands?: BuildCommands
): () => Promise<BuildContext> {
    return async () => {
        await stat(archive).catch(() => {
            throw new SourceRefusal("The uploaded source is no longer on this server. Upload the folder again.");
        });
        const dir = await mkdtemp(join(tmpdir(), "polaris-build-"));
        onOutput(Buffer.from("Unpacking the uploaded source.\n"));
        try {
            await run("tar", ["-xzf", archive, "-C", dir]);
        } catch (error) {
            await rm(dir, { recursive: true, force: true });
            throw error;
        }
        return contextFromDirectory(dir, onOutput, commands);
    };
}

/** Every trace of a service's uploaded sources, for when the service goes. */
export async function forgetUploadedSources(applicationId: string): Promise<void> {
    await rm(sourcesDir(applicationId), { recursive: true, force: true });
}

