/**
 * Reading somebody else's notes into Polaris.
 *
 * A vault of Markdown is the format worth being good at, because it is what
 * people already have: Obsidian writes plain files in plain directories, and so
 * do a dozen other editors, so an import that handles a directory of `.md`
 * handles most of what anybody will ever bring.
 *
 * Everything here is pure. What arrives from a browser is a list of paths and
 * their text, and what comes out is a plan - the folders to make, the notes to
 * write, and what was left alone - decided before a single row is created. That
 * is deliberate: an import is the one operation somebody runs once, on writing
 * they cannot get back, and a plan that can be computed and asserted without a
 * database is a plan that can be wrong in a test instead of in their vault.
 *
 * Two things are kept that a naive reader drops.
 *
 * **The frontmatter.** A leading `---` block is a file's own metadata, and
 * Polaris understands almost none of the keys people put in one. So it is lifted
 * off the body and stored beside it rather than parsed into columns or shown in
 * the editor as text: unread, unchanged, and handed back exactly as written if
 * the note is ever exported again.
 *
 * **The links.** `[[Another note]]` is how a vault refers to itself, and a naive
 * import leaves every one of them as a dead string. They are rewritten into the
 * same `polaris:note/<id>` address a mention uses, so a vault arrives with its
 * links working. One that names nothing in the import is left exactly as it was
 * rather than pointed at something plausible.
 */

import { NOTE_IMPORT_EXTENSIONS } from "./schemas/notes.js";

/** One file, as the browser read it. */
export interface ImportFile {
    /** Its path inside the vault, with `/` separators. */
    readonly path: string;
    readonly text: string;
}

/** One note the plan will write. */
export interface PlannedNote {
    /** The file it came from, which is also the key wikilinks resolve against. */
    readonly path: string;
    /** The folder path it is filed under, or null for the top of the import. */
    readonly folder: string | null;
    readonly title: string;
    /** The text with the frontmatter block removed. */
    readonly body: string;
    /** The block that was removed, verbatim and including its fences, or null. */
    readonly frontmatter: string | null;
}

/** Why a file was not imported, in words a screen can show as they are. */
export type SkipReason = "not a text file" | "empty" | "too many files";

export interface SkippedFile {
    readonly path: string;
    readonly reason: SkipReason;
}

export interface ImportPlan {
    /** Every folder to make, parents before children, as `/`-joined paths. */
    readonly folders: readonly string[];
    readonly notes: readonly PlannedNote[];
    readonly skipped: readonly SkippedFile[];
}

/**
 * A path as this module will treat it: forward slashes, no leading `./`, no
 * empty or dot segments.
 *
 * A zip is written by whatever made it, so its entry names are input. Anything
 * that tries to climb out of the vault is not repaired into something plausible;
 * the segment is dropped, and what is left is a path inside the import or
 * nothing at all.
 */
export function normalizePath(path: string): string {
    return path
        .replace(/\\/g, "/")
        .split("/")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
        .join("/");
}

/** Whether this is a file the import reads at all. */
export function isImportable(path: string): boolean {
    const lower = path.toLowerCase();
    return NOTE_IMPORT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** A path with its extension removed, which is what a wikilink names. */
function withoutExtension(path: string): string {
    const cut = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    return cut > slash ? path.slice(0, cut) : path;
}

/** The last segment of a path, extension and all. */
function basename(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * The frontmatter block at the head of a file, and the body under it.
 *
 * Only a block that opens on the very first line counts. A `---` further down is
 * a horizontal rule somebody wrote on purpose, and a reader that treated it as
 * metadata would eat the first paragraph of the note.
 *
 * The block is returned as it was written, fences included. Its keys are read
 * shallowly - `key: value` at the top level, which is what a title lives in -
 * and anything else in there is simply carried along unexamined. This is not a
 * YAML parser and does not pretend to be one.
 */
export function splitFrontmatter(text: string): {
    frontmatter: string | null;
    body: string;
    fields: Readonly<Record<string, string>>;
} {
    const normalized = text.replace(/^﻿/, "");
    if (!/^---\r?\n/.test(normalized)) return { frontmatter: null, body: normalized, fields: {} };

    const end = normalized.search(/\r?\n---[ \t]*(\r?\n|$)/);
    if (end === -1) return { frontmatter: null, body: normalized, fields: {} };

    const closing = normalized.slice(end).match(/^\r?\n---[ \t]*(\r?\n|$)/)?.[0] ?? "";
    const frontmatter = normalized.slice(0, end + closing.length).replace(/\r?\n$/, "");
    const body = normalized.slice(end + closing.length);

    const fields: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const line of frontmatter.split(/\r?\n/).slice(1, -1)) {
        const match = /^([A-Za-z0-9_-]{1,64}):[ \t]*(.*)$/.exec(line);
        if (!match) continue;
        const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
        if (value) fields[match[1]!.toLowerCase()] = value;
    }
    return { frontmatter, body, fields };
}

/** How long a title read out of a file may be before it is cut. The column
 *  stops at 200, and a heading that long is a paragraph. */
const TITLE_MAX = 200;

/**
 * What to call an imported note.
 *
 * The filename wins, because it is what the author named the thing and what
 * every link in the vault refers to it by. Frontmatter `title` is preferred only
 * when there is one, since somebody who wrote it meant it; a first heading is
 * the last resort, for the exports that name files by date.
 */
export function importedTitle(
    path: string,
    fields: Readonly<Record<string, string>>,
    body: string
): string {
    const stated = fields.title?.trim();
    if (stated) return stated.slice(0, TITLE_MAX);

    const named = withoutExtension(basename(path)).trim();
    if (named) return named.slice(0, TITLE_MAX);

    const heading = /^#{1,6}[ \t]+(.+)$/m.exec(body)?.[1]?.trim();
    return heading ? heading.slice(0, TITLE_MAX) : "Untitled";
}

/**
 * What an import will do, decided before anything is written.
 *
 * Folders come out parents-first so a caller can create them in one pass and
 * always know the parent's id. A file above the ceiling is reported rather than
 * silently dropped, and so is one that is not text: an import that says nothing
 * about what it left behind is one nobody can check.
 */
export function planImport(
    files: readonly ImportFile[],
    options: { keepFolders: boolean; maxFiles: number }
): ImportPlan {
    const notes: PlannedNote[] = [];
    const skipped: SkippedFile[] = [];
    const folders = new Set<string>();

    for (const file of files) {
        const path = normalizePath(file.path);
        if (!path || !isImportable(path)) {
            skipped.push({ path: file.path, reason: "not a text file" });
            continue;
        }
        if (notes.length >= options.maxFiles) {
            skipped.push({ path, reason: "too many files" });
            continue;
        }
        if (!file.text.trim()) {
            skipped.push({ path, reason: "empty" });
            continue;
        }

        const { frontmatter, body, fields } = splitFrontmatter(file.text);
        const directory = options.keepFolders ? path.slice(0, Math.max(0, path.lastIndexOf("/"))) : "";
        if (directory) {
            // Every level of it, so a plan never names a child before its parent.
            const segments = directory.split("/");
            for (let at = 1; at <= segments.length; at += 1) folders.add(segments.slice(0, at).join("/"));
        }
        notes.push({
            path,
            folder: directory || null,
            title: importedTitle(path, fields, body),
            body,
            frontmatter
        });
    }

    return {
        // Shallowest first, and alphabetically within a level, so the order is
        // the same on every run and a parent is always made before its child.
        folders: [...folders].sort((left, right) => {
            const depth = left.split("/").length - right.split("/").length;
            return depth !== 0 ? depth : left.localeCompare(right);
        }),
        notes,
        skipped
    };
}

/**
 * The keys a wikilink in this vault could name, against the file it means.
 *
 * A vault refers to a note in three ways - by its bare name, by its name with
 * the extension, and by a path from the vault root - so all three are indexed.
 * Where two files share a bare name the first one wins and the ambiguous key is
 * left pointing at it: a link that was ambiguous in the vault was ambiguous
 * before Polaris saw it, and picking one is what the editor itself does.
 */
export function linkIndex(notes: readonly PlannedNote[]): ReadonlyMap<string, string> {
    const index = new Map<string, string>();
    const add = (key: string, path: string) => {
        const trimmed = key.trim().toLowerCase();
        if (trimmed && !index.has(trimmed)) index.set(trimmed, path);
    };
    for (const note of notes) {
        add(withoutExtension(basename(note.path)), note.path);
        add(basename(note.path), note.path);
        add(withoutExtension(note.path), note.path);
        add(note.path, note.path);
    }
    return index;
}

/** A wikilink, and nothing that starts with `!` - an embed is a transclusion
 *  rather than a link, and rewriting one into a link would change what the page
 *  says. The target stops at `#` (a heading) or `|` (an alias). */
const WIKILINK = /(^|[^!])\[\[([^\]|#]{1,300})(#[^\]|]{0,300})?(\|([^\]]{0,300}))?\]\]/g;

/**
 * Rewrite a vault's own links into Polaris addresses.
 *
 * `resolve` answers with the id of the note a target names, or null. A target
 * nothing answers for is left exactly as it was written - a dead link that still
 * says what it was looking for is more use than a live one pointing somewhere
 * else, and it is what somebody re-running the import after adding the missing
 * file will see fixed.
 */
export function rewriteWikilinks(body: string, resolve: (target: string) => string | null): string {
    return body.replace(WIKILINK, (whole, lead: string, target: string, heading = "", _alias = "", label = "") => {
        const id = resolve(target.trim().toLowerCase());
        if (!id) return whole;
        const text = (label || target).trim() || target.trim();
        // The heading a link pointed at is kept in the text rather than dropped:
        // Polaris has no address for part of a note, and losing it silently would
        // lose what the author was pointing at.
        const shown = heading && !label ? `${text}${heading}` : text;
        return `${lead}[${shown}](polaris:note/${id})`;
    });
}

/** Every target the links in a body name, lowercased the way `linkIndex` keys
 *  are. For the caller that wants to know what an import will connect before it
 *  connects it. */
export function wikilinkTargets(body: string): string[] {
    const found = new Set<string>();
    for (const match of body.matchAll(WIKILINK)) {
        const target = match[2]?.trim().toLowerCase();
        if (target) found.add(target);
    }
    return [...found];
}
