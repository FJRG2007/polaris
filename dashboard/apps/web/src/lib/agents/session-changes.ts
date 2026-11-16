/**
 * What an agent session changed: the files that differ from where its branch
 * started, and each one's diff.
 *
 * Read from the session's own checkout - its container, or the worktree on a
 * server - so it is what the agent has right now, committed or not, rather than
 * what reached GitHub. Untracked files count: a file the agent wrote and never
 * added is the change somebody most wants to see.
 *
 * The daemon cuts what a command prints at 16 KiB and says nothing about it, so
 * no single command here is trusted to return a whole diff. The file list is
 * read a page at a time, each page kept well under the cap, and a file's diff is
 * read in base64 chunks of a fixed size: a chunk cut mid-character still decodes,
 * because the bytes are only turned back into text once they are all here.
 */

import { shellPath, shellQuote } from "./session-hooks";

/** The line every script here starts its answer on. */
const MARK = "polaris-changes:";

/** Bytes of file list per page. A page is printed raw, so this is the cap with
 *  room left for the status line. */
export const LIST_PAGE_BYTES = 12_000;

/** Bytes of diff per chunk, before base64 makes it four thirds as long. */
export const DIFF_CHUNK_BYTES = 11_000;

/** The largest diff shown. Past this the file is listed with its counts and the
 *  page says it is too large, rather than reading it in dozens of round trips. */
export const MAX_DIFF_BYTES = 160_000;

/** How many times a diff that changed mid-read is read again from the start. */
const MAX_DIFF_ATTEMPTS = 3;

/** Where a container checkout lives when the row has none recorded. */
const DEFAULT_WORKDIR = "/session/repo";

/**
 * The shell that finds the checkout and the commit the branch started from.
 *
 * The base is where the branch left the ref it was cut from. A session clones
 * that ref, so `origin/<ref>` is there; with no ref recorded it is whatever
 * `origin/HEAD` names. Failing both, the branch's own reflog remembers the
 * commit it was created on, which is the same answer for a clone whose remote
 * refs were pruned.
 */
function preamble(workdir: string, baseRef: string): string[] {
    return [
        "export GIT_TERMINAL_PROMPT=0 GIT_LITERAL_PATHSPECS=1",
        `cd ${shellPath(workdir || DEFAULT_WORKDIR)} 2>/dev/null || { echo "${MARK} nocheckout"; exit 0; }`,
        "g() { git -c safe.directory='*' -c core.quotePath=false \"$@\"; }",
        `g rev-parse --git-dir >/dev/null 2>&1 || { echo "${MARK} nocheckout"; exit 0; }`,
        `ref=${shellQuote(baseRef)}`,
        "if [ -z \"$ref\" ]; then ref=$(g symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'); fi",
        'base=""',
        'if [ -n "$ref" ]; then base=$(g merge-base HEAD "origin/$ref" 2>/dev/null || g rev-parse --verify --quiet "origin/$ref^{commit}" 2>/dev/null); fi',
        'if [ -z "$base" ]; then',
        "  head=$(g symbolic-ref --quiet --short HEAD 2>/dev/null)",
        '  [ -n "$head" ] && base=$(g reflog show --format=%H "refs/heads/$head" 2>/dev/null | tail -n 1)',
        "fi",
        `[ -n "$base" ] || { echo "${MARK} nobase"; exit 0; }`
    ];
}

/**
 * The script that lists changed files, from line `offset` of the list on.
 *
 * Tracked changes are `git diff --numstat` against the base - which covers what
 * was committed and what is only in the working tree, because the working tree
 * is what it compares - and untracked files follow, each as its line count of
 * additions. It prints the status line, then whole lines until the page is
 * full, then `more <next offset>` when the list goes on.
 */
export function listChangesScript(input: {
    workdir: string;
    baseRef: string;
    offset: number;
}): string {
    const offset = Math.max(0, Math.floor(input.offset));
    return [
        ...preamble(input.workdir, input.baseRef),
        "list() {",
        '  g diff --numstat --no-renames "$base" -- 2>/dev/null',
        // One name a line: core.quotePath is off, so only a name with a newline
        // in it would split, and `sh` has no portable way to read NUL-separated.
        "  g ls-files --others --exclude-standard 2>/dev/null | while IFS= read -r f; do",
        '    if [ -s "$f" ] && ! grep -Iq "" "$f" 2>/dev/null; then printf -- "-\\t-\\t%s\\n" "$f";',
        '    else printf "%s\\t0\\t%s\\n" "$(wc -l < "$f" | tr -d " ")" "$f"; fi',
        "  done",
        "}",
        "tmp=$(mktemp 2>/dev/null || echo /tmp/polaris-changes-$$)",
        "trap 'rm -f \"$tmp\"' EXIT",
        'list > "$tmp"',
        'total=$(wc -l < "$tmp" | tr -d " ")',
        // The checkout's fingerprint: its commit, the counts, and each changed
        // file's size and modification time. It moves whenever a write lands,
        // whoever made it - a shell command as much as an edit tool - so the
        // workspace can tell a write happened without reading every diff.
        "print=$({ g rev-parse HEAD 2>/dev/null; cat \"$tmp\"; cut -f3- \"$tmp\" | while IFS= read -r f; do stat -c '%s %Y' -- \"$f\" 2>/dev/null || echo -; done; } | cksum | awk '{ print $1 \".\" $2 }')",
        `echo "${MARK} ok $base $total $print"`,
        `tail -n +${offset + 1} "$tmp" | LC_ALL=C awk -v cap=${LIST_PAGE_BYTES} -v start=${offset} '{ size += length($0) + 1; if (size > cap) { print "${MARK} more " (start + NR - 1); exit } print }'`
    ].join("\n");
}

/** A file's line in the list. Counts are null for a binary file. */
export interface ChangedFile {
    readonly path: string;
    readonly added: number | null;
    readonly removed: number | null;
}

export type ChangesListing =
    | {
          kind: "ok";
          base: string;
          total: number;
          files: ChangedFile[];
          next: number | null;
          /** What the checkout looks like, as one value that moves with every
           *  write to it; absent from a script that predates it. */
          print?: string;
      }
    | { kind: "nocheckout" }
    | { kind: "nobase" };

/** What the list script printed, or null when it never got as far as saying. */
export function parseChangesList(output: string): ChangesListing | null {
    const lines = output.split("\n");
    const start = lines.findIndex((line) => line.startsWith(MARK));
    if (start < 0) return null;
    const [status, base, total, print] = lines[start]!.slice(MARK.length).trim().split(/\s+/);
    if (status === "nocheckout") return { kind: "nocheckout" };
    if (status === "nobase") return { kind: "nobase" };
    if (status !== "ok" || !base) return null;

    const files: ChangedFile[] = [];
    let next: number | null = null;
    for (const line of lines.slice(start + 1)) {
        if (line.startsWith(MARK)) {
            const [word, at] = line.slice(MARK.length).trim().split(/\s+/);
            if (word === "more") next = Number.parseInt(at ?? "", 10) || null;
            break;
        }
        const file = parseNumstatLine(line);
        if (file) files.push(file);
    }
    return {
        kind: "ok",
        base,
        total: Math.max(0, Number.parseInt(total ?? "0", 10) || 0),
        files,
        next,
        ...(print && /^\d+\.\d+$/.test(print) ? { print } : {})
    };
}

/** One `added<TAB>removed<TAB>path` line, `-` for each count of a binary file. */
export function parseNumstatLine(line: string): ChangedFile | null {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.replace(/\r$/, ""));
    if (!match) return null;
    const count = (value: string) => (value === "-" ? null : Number.parseInt(value, 10));
    return { added: count(match[1]!), removed: count(match[2]!), path: match[3]! };
}

/**
 * Whether a path the browser sent may be read.
 *
 * It is quoted for the shell, and pathspec magic is off, but an untracked file is
 * read with `git diff --no-index`, which reads any path at all - so a path is
 * only ever one inside the checkout: relative, with no `..` step and nothing a
 * shell or git would read as anything but a name. The script also checks that an
 * untracked path is one git lists as untracked before it reads it.
 */
export function safeChangePath(path: string): boolean {
    if (!path || path.length > 4096) return false;
    if (path.startsWith("/") || path.startsWith("-")) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(path)) return false;
    return !path.split("/").some((part) => part === ".." || part === "");
}

/**
 * The script that prints one chunk of one file's diff.
 *
 * The diff is written to a temporary file once, so its size and the chunk come
 * from the same diff, and removed before the script ends. A tracked file - or one
 * that was in the base and is gone - is diffed against the base; an untracked
 * one against nothing, and only when git itself lists it as untracked.
 */
export function fileDiffScript(input: {
    workdir: string;
    baseRef: string;
    path: string;
    offset: number;
}): string {
    const offset = Math.max(0, Math.floor(input.offset));
    const path = shellQuote(input.path);
    return [
        ...preamble(input.workdir, input.baseRef),
        `f=${path}`,
        "tmp=$(mktemp 2>/dev/null || echo /tmp/polaris-diff-$$)",
        "trap 'rm -f \"$tmp\"' EXIT",
        'if g ls-files --error-unmatch -- "$f" >/dev/null 2>&1 || g cat-file -e "$base:$f" 2>/dev/null; then',
        '  g diff --no-renames --no-color "$base" -- "$f" > "$tmp" 2>/dev/null',
        'elif g ls-files --others --exclude-standard -- "$f" 2>/dev/null | grep -qxF -- "$f"; then',
        '  g diff --no-index --no-color -- /dev/null "$f" > "$tmp" 2>/dev/null',
        "else",
        `  echo "${MARK} gone"; exit 0`,
        "fi",
        "size=$(wc -c < \"$tmp\" | tr -d ' ')",
        `if [ "$size" -gt ${MAX_DIFF_BYTES} ]; then echo "${MARK} large $size"; exit 0; fi`,
        "sum=$(cksum < \"$tmp\" | awk '{ print $1 }')",
        `echo "${MARK} chunk $size $sum"`,
        `tail -c +${offset + 1} "$tmp" | head -c ${DIFF_CHUNK_BYTES} | base64 | tr -d '\\n'`,
        "echo"
    ].join("\n");
}

export type DiffChunk =
    | { kind: "chunk"; size: number; sum: string; bytes: Buffer }
    | { kind: "large"; size: number }
    | { kind: "gone" }
    | { kind: "nocheckout" }
    | { kind: "nobase" };

export function parseDiffChunk(output: string): DiffChunk | null {
    const lines = output.split("\n");
    const start = lines.findIndex((line) => line.startsWith(MARK));
    if (start < 0) return null;
    const [status, size, sum = ""] = lines[start]!.slice(MARK.length).trim().split(/\s+/);
    const bytes = Math.max(0, Number.parseInt(size ?? "0", 10) || 0);
    switch (status) {
        case "nocheckout":
        case "nobase":
        case "gone":
            return { kind: status };
        case "large":
            return { kind: "large", size: bytes };
        case "chunk": {
            const body = (lines[start + 1] ?? "").trim();
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return null;
            return { kind: "chunk", size: bytes, sum, bytes: Buffer.from(body, "base64") };
        }
        default:
            return null;
    }
}

export type FileDiff =
    | { kind: "diff"; text: string }
    | { kind: "large"; size: number }
    | { kind: "binary" }
    | { kind: "gone" }
    | { kind: "nocheckout" }
    | { kind: "nobase" }
    | { kind: "failed" };

/**
 * Read a whole diff, chunk by chunk, through `run`.
 *
 * Every chunk carries the size and checksum of the diff it was cut from, so a
 * diff that changes while it is read - the agent is still working - is read
 * again from the start rather than spliced from two versions, and given up on
 * when it keeps changing. A chunk that comes back short of what it should have
 * held means the output was cut, and the read is a failure rather than a diff
 * with a hole in it.
 */
export async function readFileDiff(run: (offset: number) => Promise<string>): Promise<FileDiff> {
    let parts: Buffer[] = [];
    let version = "";
    let size = 0;
    let read = 0;
    let attempts = 0;
    do {
        const chunk = parseDiffChunk(await run(read));
        if (!chunk) return { kind: "failed" };
        if (chunk.kind !== "chunk") return chunk;
        const seen = `${chunk.size}:${chunk.sum}`;
        if (read === 0) {
            version = seen;
            size = chunk.size;
        } else if (seen !== version) {
            attempts += 1;
            if (attempts >= MAX_DIFF_ATTEMPTS) return { kind: "failed" };
            parts = [];
            read = 0;
            continue;
        }
        const want = Math.min(DIFF_CHUNK_BYTES, size - read);
        if (chunk.bytes.length < want) return { kind: "failed" };
        parts.push(chunk.bytes.subarray(0, want));
        read += want;
    } while (read < size);
    const text = Buffer.concat(parts).toString("utf8");
    if (/^Binary files .* differ$/m.test(text) && !/^@@ /m.test(text)) return { kind: "binary" };
    return { kind: "diff", text };
}

// ---------------------------------------------------------------------------
// Reverting
// ---------------------------------------------------------------------------

/** A diff cut into its file header and its hunks, each with the `@@` line it
 *  starts on. A diff with no hunks (a mode change, a binary file) has none. */
export interface DiffHunks {
    readonly header: string;
    readonly hunks: readonly { readonly id: string; readonly text: string }[];
}

/** A short name for a hunk's text, so a revert can say which hunk it meant and
 *  the server can tell when the diff moved under it. Not a secret: the server
 *  reads the diff again and checks it. FNV-1a, 32 bits. */
export function hunkId(text: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

export function splitHunks(text: string): DiffHunks {
    const lines = text.split("\n");
    // The last element of a text ending in a newline is empty, not a line.
    if (lines.at(-1) === "") lines.pop();
    const first = lines.findIndex((line) => line.startsWith("@@ "));
    if (first < 0) return { header: text, hunks: [] };
    const header = lines.slice(0, first).map((line) => `${line}\n`).join("");
    const hunks: { id: string; text: string }[] = [];
    let current: string[] = [];
    const close = () => {
        if (current.length === 0) return;
        const body = current.map((line) => `${line}\n`).join("");
        hunks.push({ id: hunkId(body), text: body });
        current = [];
    };
    for (const line of lines.slice(first)) {
        if (line.startsWith("@@ ")) close();
        current.push(line);
    }
    close();
    return { header, hunks };
}

/** The largest patch a hunk revert sends: it travels inside the command, and a
 *  container's command is one argument, which Linux caps at 128 KiB. */
export const MAX_HUNK_PATCH_BYTES = 64 * 1024;

/** One command line of git from its arguments, each quoted on its own: what
 *  the session's machine runs is a shell script, so an argument array is
 *  turned into words here, never pasted into the line. */
function gitLine(args: readonly string[]): string {
    return `g ${args.map(shellQuote).join(" ")}`;
}

/**
 * The script that puts one file back the way it was where the branch started.
 *
 * A file the base had is checked out from it. One the base did not have is
 * removed: from the index when the branch tracks it, and from the disk either
 * way - but only a path git itself lists as tracked or untracked, never any
 * other path that happened to be sent.
 */
export function revertFileScript(input: { workdir: string; baseRef: string; path: string }): string {
    const path = input.path;
    return [
        ...preamble(input.workdir, input.baseRef),
        `f=${shellQuote(path)}`,
        'if g cat-file -e "$base:$f" 2>/dev/null; then',
        `  ${gitLine(["checkout"])} "$base" -- "$f" >/dev/null 2>&1 || { echo "${MARK} failed"; exit 0; }`,
        'elif g ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then',
        `  ${gitLine(["rm", "-q", "-f", "--"])} "$f" >/dev/null 2>&1 || { echo "${MARK} failed"; exit 0; }`,
        'elif g ls-files --others --exclude-standard -- "$f" 2>/dev/null | grep -qxF -- "$f"; then',
        `  rm -f -- "$f" || { echo "${MARK} failed"; exit 0; }`,
        "else",
        `  echo "${MARK} gone"; exit 0`,
        "fi",
        `echo "${MARK} reverted"`
    ].join("\n");
}

/**
 * The script that takes one hunk back out of the working tree: the hunk, under
 * its file's header, applied in reverse. git checks every context line against
 * the file as it is now, so a file that moved since the diff was read refuses
 * the patch rather than taking it somewhere else.
 */
export function revertHunkScript(input: { workdir: string; baseRef: string; patch: string }): string {
    const encoded = Buffer.from(input.patch, "utf8").toString("base64");
    return [
        ...preamble(input.workdir, input.baseRef),
        "tmp=$(mktemp 2>/dev/null || echo /tmp/polaris-revert-$$)",
        "trap 'rm -f \"$tmp\"' EXIT",
        `printf '%s' ${shellQuote(encoded)} | base64 -d > "$tmp" 2>/dev/null || { echo "${MARK} failed"; exit 0; }`,
        `${gitLine(["apply", "-R", "--whitespace=nowarn"])} "$tmp" >/dev/null 2>&1 || { echo "${MARK} stale"; exit 0; }`,
        `echo "${MARK} reverted"`
    ].join("\n");
}

export type RevertResult = "reverted" | "gone" | "stale" | "failed" | "nocheckout" | "nobase";

/** What a revert script said, or null when it never got as far as saying. */
export function parseRevert(output: string): RevertResult | null {
    const line = output.split("\n").find((row) => row.startsWith(MARK));
    const word = line?.slice(MARK.length).trim().split(/\s+/)[0];
    return word === "reverted" ||
        word === "gone" ||
        word === "stale" ||
        word === "failed" ||
        word === "nocheckout" ||
        word === "nobase"
        ? word
        : null;
}
