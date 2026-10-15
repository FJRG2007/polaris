/**
 * Reading a cPanel full-account backup (`backup-<date>_<user>.tar.gz`) into a plan
 * for a Polaris project: the site's files, its MySQL dumps and its domains.
 *
 * The archive's layout, as cPanel writes it:
 *
 *   homedir/ or homedir.tar   the account's home; each site's document root is in it
 *                             (a homedir.tar is checked and unpacked into homedir/)
 *   mysql/<db>.sql            one dump per database
 *   userdata/main             main_domain, addon and sub domains
 *   userdata/<domain>         one domain's settings, `documentroot:` among them
 *
 * An archive is read only when somebody imports one: listed first, refused on
 * anything that could write outside the scratch directory (an absolute path, a
 * parent step, a link, a device), capped on what it unpacks to, then unpacked
 * with `tar` given an argument list and nothing from the archive on its command
 * line. The scratch directory is removed by the caller once the import is done.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";

/** A reason a backup was refused, worded for whoever uploaded it. */
export class BackupRefusal extends Error {}

/** The most a backup may unpack to, and how many entries it may hold. */
export const MAX_BACKUP_BYTES = 20 * 1024 ** 3;
export const MAX_BACKUP_ENTRIES = 500_000;

/** Files under `userdata/` that are not one domain's settings. */
const USERDATA_SKIP = new Set(["main", "cache", "cache.json"]);

/** The folders that mark the root of a cPanel backup. */
const MARKERS = ["cp", "userdata", "homedir", "homedir.tar", "mysql"];

/** Something an import could not carry over, as a code the screen words in the
 *  reader's language and the value it names. */
export const IMPORT_WARNING_CODES = ["noDomains", "noHome", "databaseFailed", "folderMissing", "domainTaken", "notDeploying"] as const;
export type ImportWarningCode = (typeof IMPORT_WARNING_CODES)[number];
export interface ImportWarning {
    readonly code: ImportWarningCode;
    /** The database, site or domain it is about, for the codes that name one. */
    readonly name?: string;
}

export interface ImportDomain {
    readonly name: string;
    readonly primary: boolean;
    /** The document root inside the home folder (`public_html`, `addon.example/web`), or "" for the home itself. */
    readonly documentRoot: string;
}

export interface ImportDatabase {
    readonly name: string;
    /** The dump's path from the backup root. */
    readonly dump: string;
    readonly bytes: number;
}

export interface CpanelPlan {
    readonly account: string | null;
    readonly domains: ImportDomain[];
    readonly databases: ImportDatabase[];
    /** Whether the home folder is in the backup at all. */
    readonly hasHome: boolean;
    /** Things the import cannot carry over, for the reader to see before it runs. */
    readonly warnings: ImportWarning[];
}

/**
 * What is wrong with one entry of the archive's verbose listing (`tar -tvzf`),
 * or null when it may be unpacked. Only regular files and folders are taken.
 */
export function listingProblem(line: string): string | null {
    const type = line.charAt(0);
    if (type !== "-" && type !== "d") return "The backup contains links or special files, which are not imported.";
    // "drwxr-xr-x user/group 0 2026-01-01 00:00 path" - the path is everything after the time.
    const match = /^\S+\s+\S+\s+\d+\s+\S+\s+\S+\s(.+)$/.exec(line);
    if (!match) return "The backup's file list could not be read.";
    return entryNameProblem(match[1] ?? "");
}

/** Whether an entry's name stays inside the folder it is unpacked into. */
export function entryNameProblem(name: string): string | null {
    const unified = name.replace(/\\/g, "/");
    if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return "The backup contains an absolute path.";
    if (unified.split("/").some((segment) => segment === "..")) return "The backup contains a path that leaves its folder.";
    if ([...unified].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
        return "The backup contains a file name with control characters.";
    }
    return null;
}

/** The size column of a verbose listing line, in bytes. */
export function listingBytes(line: string): number {
    const match = /^\S+\s+\S+\s+(\d+)\s/.exec(line);
    return match ? Number(match[1]) : 0;
}

/** Checks a whole verbose listing and answers how much it unpacks to. */
export function checkListing(listing: string): { entries: number; bytes: number } {
    const lines = listing.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) throw new BackupRefusal("The backup is empty.");
    if (lines.length > MAX_BACKUP_ENTRIES) throw new BackupRefusal(`The backup has more than ${MAX_BACKUP_ENTRIES} files.`);
    let bytes = 0;
    for (const line of lines) {
        const problem = listingProblem(line);
        if (problem) throw new BackupRefusal(problem);
        bytes += listingBytes(line);
        if (bytes > MAX_BACKUP_BYTES) throw new BackupRefusal(`The backup unpacks to more than ${MAX_BACKUP_BYTES / 1024 ** 3} GB.`);
    }
    return { entries: lines.length, bytes };
}

/** A cPanel `key: value` settings file, keys lowercased, quotes dropped. */
export function parseKeyValues(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        if (!line.includes(":") || line.trimStart().startsWith("#") || line.startsWith(" ")) continue;
        const at = line.indexOf(":");
        const key = line.slice(0, at).trim().toLowerCase();
        const value = line.slice(at + 1).trim().replace(/^['"]|['"]$/g, "");
        if (key) out[key] = value;
    }
    return out;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A document root as cPanel writes it (`/home/user/public_html`), relative to the home. */
export function relativeDocumentRoot(documentRoot: string | undefined, account: string | null): string {
    if (!documentRoot) return "public_html";
    const unified = documentRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    const home = account ? `/home/${account}` : null;
    let relative = unified;
    if (home && (unified === home || unified.startsWith(`${home}/`))) relative = unified.slice(home.length);
    else relative = unified.replace(/^\/home\d*\/[^/]+/, "");
    relative = relative.replace(/^\/+/, "");
    return entryNameProblem(relative) ? "public_html" : relative;
}

/**
 * The plan for an unpacked backup, from what its settings files say. Pure: the
 * caller reads the files, so this can be checked without a backup on disk.
 */
export function planFrom(input: {
    account: string | null;
    userdataMain: string | null;
    userdata: Readonly<Record<string, string>>;
    dumps: readonly { file: string; bytes: number }[];
    hasHome: boolean;
}): CpanelPlan {
    const warnings: ImportWarning[] = [];
    const main = parseKeyValues(input.userdataMain ?? "");
    const mainDomain = main.main_domain?.toLowerCase() ?? null;
    const domains: ImportDomain[] = [];
    for (const [entry, text] of Object.entries(input.userdata)) {
        if (USERDATA_SKIP.has(entry) || entry.endsWith(".json") || entry.endsWith("_SSL")) continue;
        const name = entry.toLowerCase();
        if (!DOMAIN.test(name)) continue;
        const settings = parseKeyValues(text);
        domains.push({
            name,
            primary: name === mainDomain,
            documentRoot: relativeDocumentRoot(settings.documentroot, input.account)
        });
    }
    domains.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
    if (domains.length === 0) warnings.push({ code: "noDomains" });
    if (!input.hasHome) warnings.push({ code: "noHome" });
    const databases = input.dumps
        .filter((dump) => dump.file.endsWith(".sql"))
        .map((dump) => ({ name: dump.file.slice(0, -4), dump: `mysql/${dump.file}`, bytes: dump.bytes }))
        .filter((database) => /^[A-Za-z0-9_$-]{1,64}$/.test(database.name))
        .sort((a, b) => a.name.localeCompare(b.name));
    return { account: input.account, domains, databases, hasHome: input.hasHome, warnings };
}

function run(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const out: Buffer[] = [];
        let said = "";
        child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => {
            if (said.length < 2000) said += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) =>
            code === 0
                ? resolve(Buffer.concat(out).toString("utf8"))
                : reject(new Error(said.trim() || `${command} exited with code ${code ?? -1}`))
        );
    });
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false
    );
}

/** The backup's root inside the unpacked folder: itself, or its one `backup-*` folder. */
async function backupRoot(dir: string): Promise<string> {
    for (const marker of MARKERS) if (await exists(join(dir, marker))) return dir;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const marker of MARKERS) if (await exists(join(dir, entry.name, marker))) return join(dir, entry.name);
    }
    throw new BackupRefusal("That is not a cPanel account backup.");
}

/**
 * A home folder the backup carries as `homedir.tar` instead of a folder: checked
 * the same way as the backup itself, then unpacked into `<root>/homedir`, and the
 * tar dropped so the scratch folder does not hold the site twice.
 */
async function unpackHomeTar(root: string): Promise<void> {
    const tar = join(root, "homedir.tar");
    const home = join(root, "homedir");
    if (!(await exists(tar)) || (await exists(home))) return;
    let listing: string;
    try {
        listing = await run("tar", ["-tvf", tar]);
    } catch {
        throw new BackupRefusal("The backup's home folder could not be read.");
    }
    checkListing(listing);
    await mkdir(home, { recursive: true });
    await run("tar", ["-xf", tar, "-C", home, "--no-same-owner", "--no-same-permissions"]);
    await rm(tar, { force: true });
}

/**
 * Check and unpack a backup into a new scratch folder and answer its plan and
 * where its root is. The caller removes `dir` when it is done with it.
 */
export async function inspectCpanelBackup(archive: string): Promise<{ dir: string; root: string; plan: CpanelPlan }> {
    let listing: string;
    try {
        listing = await run("tar", ["-tvzf", archive]);
    } catch {
        throw new BackupRefusal("That is not a .tar.gz backup.");
    }
    checkListing(listing);
    const dir = await mkdtemp(join(tmpdir(), "polaris-panel-import-"));
    try {
        await run("tar", ["-xzf", archive, "-C", dir, "--no-same-owner", "--no-same-permissions"]);
        const root = await backupRoot(dir);
        const account = (await readdir(join(root, "cp")).catch(() => [] as string[]))[0] ?? null;
        const userdataDir = join(root, "userdata");
        const userdata: Record<string, string> = {};
        for (const entry of await readdir(userdataDir, { withFileTypes: true }).catch(() => [])) {
            if (!entry.isFile() || USERDATA_SKIP.has(entry.name)) continue;
            userdata[entry.name] = await readFile(join(userdataDir, entry.name), "utf8");
        }
        const dumps: { file: string; bytes: number }[] = [];
        for (const entry of await readdir(join(root, "mysql"), { withFileTypes: true }).catch(() => [])) {
            if (entry.isFile()) dumps.push({ file: entry.name, bytes: (await stat(join(root, "mysql", entry.name))).size });
        }
        const plan = planFrom({
            account,
            userdataMain: await readFile(join(userdataDir, "main"), "utf8").catch(() => null),
            userdata,
            dumps,
            hasHome: (await exists(join(root, "homedir"))) || (await exists(join(root, "homedir.tar")))
        });
        await unpackHomeTar(root);
        return { dir, root, plan };
    } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
    }
}
