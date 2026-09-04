/**
 * Writing notes back out as a vault of Markdown.
 *
 * The other half of `notes-import`, and deliberately its mirror: what comes out
 * is what a vault looks like on disk, so it opens in Obsidian, or in a text
 * editor, or in nothing at all - a folder of files somebody can read in twenty
 * years without Polaris existing. That is the point of storing Markdown in the
 * first place, and an export that produced anything else would quietly undo it.
 *
 * Three things are restored on the way out.
 *
 * **The frontmatter.** It was lifted off the body on the way in and kept
 * verbatim, so it goes back exactly where it was. A note that came from a vault
 * leaves as the file it arrived as.
 *
 * **The links.** A reference to another note is stored as a `polaris:note/<id>`
 * address, which means nothing outside Polaris. Where the note it names is in
 * the same export it becomes `[[Its title]]` again, which is what the vault
 * wrote and what every Markdown editor with a wiki understands. Where it is not,
 * the address is left alone rather than turned into a link that goes nowhere.
 *
 * **The arrangement.** A folder is a directory and a note is a file in it. A
 * note that holds other notes becomes both - a file and a directory beside it
 * with the same name - because that is how a vault represents exactly this, and
 * inventing a different shape would mean an export that does not re-import.
 */

/** Characters a file cannot be named on Windows, on macOS, or inside a zip. */
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Names Windows refuses whatever the extension is. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** How long one path segment may be. Well under every filesystem's limit, and
 *  short enough that a deep tree of them still fits in a path. */
const MAX_SEGMENT = 80;

/**
 * A title, as a file can be named.
 *
 * Trailing dots and spaces go too: Windows drops them silently when the file is
 * written, which turns two notes into one file without saying so.
 */
export function fileNameFor(title: string): string {
    const cleaned = title
        .replace(FORBIDDEN, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/, "")
        .slice(0, MAX_SEGMENT)
        .replace(/[. ]+$/, "");
    if (!cleaned || RESERVED.test(cleaned)) return cleaned ? `${cleaned}_` : "Untitled";
    return cleaned;
}

/**
 * The same path, made unique against the ones already taken.
 *
 * Two notes on one shelf can share a title - nothing stops them, and after an
 * import from somewhere with no such rule it is common. The second one gets a
 * number rather than overwriting the first, which is what a file manager does
 * and what somebody expects.
 */
export function uniquePath(taken: Set<string>, path: string, extension = ".md"): string {
    // `slice(0, -0)` is `slice(0, 0)`, which is the empty string - so an empty
    // extension has to be its own case rather than a clever one.
    const base = extension && path.endsWith(extension) ? path.slice(0, -extension.length) : path;
    let candidate = `${base}${extension}`;
    for (let at = 2; taken.has(candidate.toLowerCase()); at += 1) {
        candidate = `${base} (${at})${extension}`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
}

/** A Polaris reference inside a body: `[label](polaris:note/<uuid>)`. */
const REFERENCE = /\[([^\]]*)\]\(polaris:note\/([0-9a-f-]{8,64})\)/gi;

/**
 * Turn references back into the wiki links a vault writes.
 *
 * `resolve` answers with the title of the note an id names, or null when that
 * note is not part of this export. An unresolved one is left exactly as it was:
 * the address is at least honest about pointing at something in Polaris, and
 * rewriting it into a link to a file that is not in the zip would be a broken
 * link that looks like a working one.
 *
 * The label is kept as an alias where it differs from the title, which is the
 * form every editor supports and the one that survives being re-imported.
 */
export function toWikilinks(body: string, resolve: (id: string) => string | null): string {
    return body.replace(REFERENCE, (whole, label: string, id: string) => {
        const title = resolve(id);
        if (!title) return whole;
        const shown = label.trim();
        return shown && shown !== title ? `[[${title}|${shown}]]` : `[[${title}]]`;
    });
}

/** A note's file, frontmatter and all. */
export function noteFile(note: { frontmatter: string | null; body: string }): string {
    const body = note.body.endsWith("\n") || note.body === "" ? note.body : `${note.body}\n`;
    if (!note.frontmatter) return body;
    return `${note.frontmatter.replace(/\s*$/, "")}\n${body}`;
}

/** One entry of the archive. */
export interface ExportFile {
    readonly path: string;
    readonly text: string;
}

/** A note as the export reads it, flat, with where it sits. */
export interface ExportableNote {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly frontmatter: string | null;
    readonly folderId: string | null;
    readonly parentId: string | null;
}

/** A folder as the export reads it. */
export interface ExportableFolder {
    readonly id: string;
    readonly name: string;
    readonly parentId: string | null;
}

/**
 * Lay a shelf out as files.
 *
 * Directories first, so a note always has one to go in, and then the notes
 * depth-first from the top: a note that holds others names the directory they go
 * in, and it can only do that once its own name is settled.
 *
 * Everything is decided here and nothing is read from a database, so the layout
 * of an export - the thing that is hardest to notice going wrong and impossible
 * to fix afterwards - can be asserted in a test.
 */
export function layOutExport(
    notes: readonly ExportableNote[],
    folders: readonly ExportableFolder[]
): ExportFile[] {
    const titles = new Map(notes.map((note) => [note.id, note.title]));
    const resolve = (id: string) => titles.get(id) ?? null;

    // Where each folder sits, parents before children.
    const folderPath = new Map<string | null, string>([[null, ""]]);
    const byParent = new Map<string | null, ExportableFolder[]>();
    for (const folder of folders) {
        const bucket = byParent.get(folder.parentId) ?? [];
        bucket.push(folder);
        byParent.set(folder.parentId, bucket);
    }
    const walkFolders = (parentId: string | null, prefix: string) => {
        const taken = new Set<string>();
        for (const folder of byParent.get(parentId) ?? []) {
            const name = uniquePath(taken, fileNameFor(folder.name), "");
            const path = prefix ? `${prefix}/${name}` : name;
            folderPath.set(folder.id, path);
            walkFolders(folder.id, path);
        }
    };
    walkFolders(null, "");

    const children = new Map<string | null, ExportableNote[]>();
    for (const note of notes) {
        const bucket = children.get(note.parentId) ?? [];
        bucket.push(note);
        children.set(note.parentId, bucket);
    }

    const files: ExportFile[] = [];
    const takenAt = new Map<string, Set<string>>();
    const walkNotes = (parentId: string | null, prefix: string | null) => {
        for (const note of children.get(parentId) ?? []) {
            // A top-level note goes in its folder; a nested one goes in the
            // directory its parent named, which is what a vault does with a page
            // that has pages under it.
            const directory = prefix ?? folderPath.get(note.folderId) ?? "";
            const taken = takenAt.get(directory) ?? new Set<string>();
            takenAt.set(directory, taken);

            const name = uniquePath(taken, fileNameFor(note.title));
            files.push({
                path: directory ? `${directory}/${name}` : name,
                text: noteFile({ frontmatter: note.frontmatter, body: toWikilinks(note.body, resolve) })
            });

            if ((children.get(note.id) ?? []).length > 0) {
                const folder = name.replace(/\.md$/, "");
                walkNotes(note.id, directory ? `${directory}/${folder}` : folder);
            }
        }
    };
    walkNotes(null, null);
    return files;
}
