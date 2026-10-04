/**
 * An in-memory storage driver for Drive tests: files and folders by path, with
 * the name matching of either kind of storage - exact (a Linux disk, S3) or
 * case-insensitive (SMB, a Windows or macOS disk), where "report.pdf" finds
 * "Report.pdf".
 */

import { StorageError, type StatEntry, type StorageDriver } from "@polaris/storage";

export interface MemoryDriver {
    readonly driver: StorageDriver;
    /** File contents by their stored path. */
    readonly files: Map<string, string>;
    readonly dirs: Set<string>;
}

let counter = 0;

export function memoryDriver(
    seed: { files?: Record<string, string>; dirs?: string[] } = {},
    options: { caseInsensitive?: boolean; failMoveFrom?: string } = {}
): MemoryDriver {
    const files = new Map(Object.entries(seed.files ?? {}));
    const dirs = new Set(seed.dirs ?? []);
    const key = (path: string) => (options.caseInsensitive ? path.toLowerCase() : path);
    const findFile = (path: string) =>
        [...files.keys()].find((stored) => key(stored) === key(path));
    const findDir = (path: string) => [...dirs].find((stored) => key(stored) === key(path));
    const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
    const nameOf = (path: string) => path.split("/").pop() ?? path;
    const entry = (path: string, kind: "file" | "dir"): StatEntry => ({
        name: nameOf(path),
        path,
        kind,
        size: BigInt(kind === "file" ? (files.get(path) ?? "").length : 0),
        modifiedAt: new Date(0)
    });
    const notFound = (path: string) => new StorageError("not_found", `Not found: ${path}`);

    const driver = {
        id: `memory-${++counter}`,
        kind: "local",
        capabilities: {
            randomRead: true,
            randomWrite: true,
            move: true,
            usage: false,
            requiresHostd: false
        },
        async connect() {},
        async dispose() {},
        async list(path: string) {
            if (path && !findDir(path)) throw notFound(path);
            const inside = (stored: string) => key(parentOf(stored)) === key(path);
            return {
                entries: [
                    ...[...dirs].filter(inside).map((dir) => entry(dir, "dir")),
                    ...[...files.keys()].filter(inside).map((file) => entry(file, "file"))
                ]
            };
        },
        async stat(path: string) {
            const file = findFile(path);
            if (file !== undefined) return entry(file, "file");
            const dir = findDir(path);
            if (dir !== undefined) return entry(dir, "dir");
            throw notFound(path);
        },
        async readStream(path: string) {
            const file = findFile(path);
            if (file === undefined) throw notFound(path);
            const body = files.get(file) ?? "";
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(body));
                    controller.close();
                }
            });
        },
        async writeStream(path: string, body: ReadableStream<Uint8Array>) {
            const text = await new Response(body).text();
            const stored = findFile(path) ?? path;
            files.set(stored, text);
            return entry(stored, "file");
        },
        async mkdir(path: string) {
            const parts = path.split("/");
            for (let index = 1; index <= parts.length; index++) {
                const dir = parts.slice(0, index).join("/");
                if (!findDir(dir)) dirs.add(dir);
            }
        },
        async move(from: string, to: string) {
            if (options.failMoveFrom === from)
                throw new StorageError("io_error", `Cannot move ${from}`);
            const file = findFile(from);
            if (file !== undefined) {
                const body = files.get(file) ?? "";
                files.delete(file);
                const existing = findFile(to);
                if (existing !== undefined) files.delete(existing);
                files.set(to, body);
                return;
            }
            const dir = findDir(from);
            if (dir === undefined) throw notFound(from);
            for (const stored of [...dirs]) {
                if (stored === dir || stored.startsWith(`${dir}/`)) {
                    dirs.delete(stored);
                    dirs.add(`${to}${stored.slice(dir.length)}`);
                }
            }
            for (const [stored, body] of [...files]) {
                if (stored.startsWith(`${dir}/`)) {
                    files.delete(stored);
                    files.set(`${to}${stored.slice(dir.length)}`, body);
                }
            }
        },
        async delete(path: string) {
            const file = findFile(path);
            if (file !== undefined) {
                files.delete(file);
                return;
            }
            for (const stored of [...dirs]) {
                if (key(stored) === key(path) || key(stored).startsWith(`${key(path)}/`))
                    dirs.delete(stored);
            }
            for (const stored of [...files.keys()]) {
                if (key(stored).startsWith(`${key(path)}/`)) files.delete(stored);
            }
        },
        async usage() {
            return {};
        }
    } as unknown as StorageDriver;
    return { driver, files, dirs };
}
