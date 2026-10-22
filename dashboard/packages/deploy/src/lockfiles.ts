/**
 * The lockfiles of a deployed commit, as dependency scanning moves them: the
 * names Grype's directory catalogers read, the bounds kept on them, how they
 * are stored with a queued scan, and the build context that carries them to
 * the server inside a throwaway image on top of the scanner's. Pure; the
 * dashboard reads them out of the deploy's clone, the security scans run them.
 */

/** The files Grype's directory catalogers read declared dependencies from. */
export const LOCKFILE_NAMES: readonly string[] = [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "poetry.lock",
    "uv.lock",
    "Pipfile.lock",
    "requirements.txt",
    "go.mod",
    "go.sum",
    "Cargo.lock",
    "composer.lock",
    "Gemfile.lock",
    "pom.xml",
    "gradle.lockfile",
    "packages.lock.json",
    "mix.lock",
    "pubspec.lock"
];

/** One lockfile is never larger than this; a bigger one is left out. */
export const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
/** All of a deploy's lockfiles together, before compression. */
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** What is stored with the scan, compressed. */
export const MAX_STORED_BYTES = 8 * 1024 * 1024;
/** A path longer than a tar header's name field is left out, not truncated. */
export const MAX_LOCKFILE_PATH = 100;

export interface Lockfile {
    /** Relative to the repository root, `/`-separated. */
    readonly path: string;
    readonly body: Buffer;
}

/**
 * The directories a service's lockfiles can be in, repository root first, then
 * each one down to its root directory - a workspace keeps its lockfile at the
 * top, a service in a subfolder may have its own. Null when the root directory
 * leaves the repository. Pure.
 */
export function lockfileDirs(rootDirectory: string): string[] | null {
    const parts = rootDirectory
        .replace(/\\/g, "/")
        .split("/")
        .filter((part) => part !== "" && part !== ".");
    if (parts.some((part) => part === "..")) return null;
    const dirs = [""];
    for (let index = 1; index <= parts.length; index++) {
        dirs.push(parts.slice(0, index).join("/"));
    }
    return dirs;
}

function tarHeader(name: string, size: number, type: "0" | "5"): Buffer {
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "utf8");
    header.write(type === "5" ? "0000755\0" : "0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    // The checksum is computed with its own field read as eight spaces.
    header.write("        ", 148, 8, "ascii");
    header.write(type, 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    return header;
}

/**
 * The build context the scan sends: a Dockerfile that puts the lockfiles on
 * top of the scanner's image, and the lockfiles under `src/`. Pure; a ustar
 * archive with every directory it needs declared.
 */
export function dependencyContext(files: readonly Lockfile[], scannerImage: string): Buffer {
    if (!/^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(scannerImage)) {
        throw new Error("The scanner is named by its digest");
    }
    const parts: Buffer[] = [];
    const add = (name: string, body: Buffer): void => {
        parts.push(tarHeader(name, body.length, "0"), body);
        parts.push(Buffer.alloc((512 - (body.length % 512)) % 512, 0));
    };
    add("Dockerfile", Buffer.from(`FROM ${scannerImage}\nCOPY src /src\n`, "utf8"));
    const dirs = new Set<string>(["src/"]);
    for (const file of files) {
        const segments = `src/${file.path}`.split("/").slice(0, -1);
        for (let index = 1; index <= segments.length; index++) {
            dirs.add(`${segments.slice(0, index).join("/")}/`);
        }
    }
    for (const dir of [...dirs].sort()) parts.push(tarHeader(dir, 0, "5"));
    for (const file of files) add(`src/${file.path}`, file.body);
    parts.push(Buffer.alloc(1024, 0));
    return Buffer.concat(parts);
}

/**
 * The lockfiles as they are stored with a queued scan: each one a JSON line
 * naming its path and size, then its bytes. Pure.
 */
export function encodeLockfiles(files: readonly Lockfile[]): Buffer {
    return Buffer.concat(
        files.map((file) =>
            Buffer.concat([
                Buffer.from(`${JSON.stringify({ path: file.path, size: file.body.length })}
`),
                file.body
            ])
        )
    );
}

/** A path a lockfile may be stored under: relative, inside the repository, a
 *  known name, short enough for the archive. */
export function isLockfilePath(path: string): boolean {
    if (Buffer.byteLength(`src/${path}`) > MAX_LOCKFILE_PATH) return false;
    const parts = path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
    if (!/^[A-Za-z0-9._@+ -]+$/.test(parts.join(""))) return false;
    return LOCKFILE_NAMES.includes(parts[parts.length - 1]!);
}

/**
 * Read stored lockfiles back. Stored data is input like any other: a record
 * that does not parse, names a path that is not a lockfile, or runs past the
 * end ends the read, and what was read before it is kept. Pure.
 */
export function decodeLockfiles(data: Buffer): Lockfile[] {
    const files: Lockfile[] = [];
    let offset = 0;
    let total = 0;
    while (offset < data.length) {
        const end = data.indexOf(0x0a, offset);
        if (end < 0 || end - offset > 1024) break;
        let head: unknown;
        try {
            head = JSON.parse(data.subarray(offset, end).toString("utf8"));
        } catch {
            break;
        }
        const { path, size } = (head ?? {}) as { path?: unknown; size?: unknown };
        if (typeof path !== "string" || !isLockfilePath(path)) break;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) break;
        if (size > MAX_LOCKFILE_BYTES || total + size > MAX_TOTAL_BYTES) break;
        if (end + 1 + size > data.length) break;
        files.push({ path, body: Buffer.from(data.subarray(end + 1, end + 1 + size)) });
        total += size;
        offset = end + 1 + size;
    }
    return files;
}
