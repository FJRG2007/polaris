/**
 * An agent's memory of a repository, kept with the person rather than the box.
 *
 * On somebody's own laptop the agent remembers each repository on its own:
 * Claude Code keys its memory folder by the checkout's path, and Enigma keys
 * its handoff page by the git root. A session used to check every repository
 * out at the same path in a home kept per person per box, so every repository
 * of one person shared one memory and one handoff, and nothing reached another
 * box at all.
 *
 * Two halves fix that. Every repository is checked out at a path of its own,
 * the same on every box (`repoCheckoutDir`), so each store the tools key by
 * the path is that repository's. And the session carries those stores to
 * Polaris at the end of each turn and puts them back when it boots
 * (`memorySyncScript`), so they follow the person to whichever box runs the
 * next session. Nothing is parsed on the machine: what arrives is validated
 * here (`parseMemoryUpload`), where it is a pure function with tests on it.
 */

import { z } from "zod";
import { shellQuote } from "./session-hooks";
import { AGENT_HOME, SESSION_ROOT } from "./session-commands";

/** Where every repository checkout of a container session lives. */
export const REPO_CHECKOUTS = `${SESSION_ROOT}/repos`;

/** One file the agent kept, at most. A memory page is text; anything larger is
 *  not memory, and is left on the box. */
export const MEMORY_FILE_MAX_BYTES = 256 * 1024;

/** Everything one person keeps for one repository, at most. */
export const MEMORY_TOTAL_MAX_BYTES = 2 * 1024 * 1024;

/** How many files one repository's memory may hold. */
export const MEMORY_MAX_FILES = 200;

/**
 * A repository as one directory name: `owner__name`, lowercased because GitHub
 * names are case-insensitive. GitHub owners never contain `_`, so the double
 * underscore cannot be produced by two different repositories. Null for a name
 * that is not `owner/name`.
 */
export function memoryKey(repoFullName: string): string | null {
    const parts = repoFullName.trim().toLowerCase().split("/");
    if (parts.length !== 2) return null;
    const [owner = "", name = ""] = parts.map((part) => part.replace(/[^a-z0-9._-]/g, "-"));
    if (!/^[a-z0-9-]{1,39}$/.test(owner) || !/^[a-z0-9._-]{1,100}$/.test(name)) return null;
    if (/^\.+$/.test(name)) return null;
    return `${owner}__${name}`;
}

/** Where a container session checks a repository out. The same path on every
 *  box, so a store keyed by the path is the same store on every box. */
export function repoCheckoutDir(repoFullName: string): string {
    const key = memoryKey(repoFullName);
    if (!key) throw new Error(`Polaris cannot read ${repoFullName} as a GitHub repository name.`);
    return `${REPO_CHECKOUTS}/${key}`;
}

/** Where the agent's own memory of a repository lives in a container's home.
 *  Pointed at with Claude Code's `autoMemoryDirectory`. */
export function repoMemoryDir(repoFullName: string): string {
    const key = memoryKey(repoFullName);
    if (!key) throw new Error(`Polaris cannot read ${repoFullName} as a GitHub repository name.`);
    return `${AGENT_HOME}/.polaris/memory/${key}`;
}

/** Enigma's handoff pages, in the container's home. */
export const HANDOFF_DIR = `${AGENT_HOME}/.enigma/handoff`;

// A path segment that cannot be `..`, a hidden file or empty.
const SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}";
const MEMORY_PATH = new RegExp(
    `^(?:memory/(?:${SEGMENT}/){0,3}${SEGMENT}|handoff/[0-9a-f]{8,64}\\.(?:md|json))$`
);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** How many bytes a base64 string decodes to, without decoding it. */
export function decodedLength(data: string): number {
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return Math.floor((data.length * 3) / 4) - padding;
}

const memoryFile = z.object({
    path: z
        .string()
        .max(600)
        .regex(MEMORY_PATH)
        .refine((path) => !path.split("/").includes(".."), "parent directory"),
    data: z
        .string()
        .max(Math.ceil(MEMORY_FILE_MAX_BYTES / 3) * 4)
        .refine((data) => data.length % 4 === 0 && BASE64.test(data), "not base64")
});

export type MemoryFile = z.infer<typeof memoryFile>;

/** What a session uploads: the whole of the repository's memory as it stands. */
export const memoryUploadSchema = z
    .object({ files: z.array(memoryFile).max(MEMORY_MAX_FILES) })
    .strict()
    .superRefine((value, ctx) => {
        const seen = new Set<string>();
        let total = 0;
        for (const file of value.files) {
            if (seen.has(file.path)) ctx.addIssue({ code: "custom", message: `duplicate ${file.path}` });
            seen.add(file.path);
            total += decodedLength(file.data);
        }
        if (total > MEMORY_TOTAL_MAX_BYTES) ctx.addIssue({ code: "custom", message: "too large" });
    });

/** The upload, or null for anything that is not exactly the shape above. */
export function parseMemoryUpload(body: unknown): MemoryFile[] | null {
    const parsed = memoryUploadSchema.safeParse(body);
    return parsed.success ? parsed.data.files : null;
}

/** A stored row's files, read total: anything that no longer passes the
 *  upload's own rules is dropped rather than served to a box. */
export function readStoredFiles(value: unknown): MemoryFile[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        const parsed = memoryFile.safeParse(item);
        return parsed.success ? [parsed.data] : [];
    });
}

/** The total of what a set of files decodes to. */
export function memoryBytes(files: readonly MemoryFile[]): number {
    return files.reduce((sum, file) => sum + decodedLength(file.data), 0);
}

/**
 * What the boot reads back: a stamp line, then one `path<TAB>base64` line per
 * file. Text a POSIX `read` loop can take, because the machine may have no
 * JSON parser. `updated=0` is "nothing stored".
 */
export function restoreBody(files: readonly MemoryFile[], updatedAt: Date | null): string {
    const stamp = updatedAt && files.length > 0 ? updatedAt.getTime() : 0;
    return [`updated=${stamp}`, ...files.map((file) => `${file.path}\t${file.data}`), ""].join("\n");
}

/** The stamp line an upload is answered with, which the box keeps beside the
 *  memory so the next boot on it knows whether its copy is the stored one. */
export function uploadAnswer(updatedAt: Date | null): string {
    return `updated=${updatedAt ? updatedAt.getTime() : 0}\n`;
}

export interface MemorySyncPaths {
    /** The upload and restore endpoint. */
    readonly url: string;
    /** The session's own reporting token. */
    readonly token: string;
    /** The checkout, which is the git root Enigma records in a handoff. */
    readonly workdir: string;
    /** The agent's memory folder for this repository. */
    readonly memoryDir: string;
    /** Enigma's handoff folder. */
    readonly handoffDir: string;
}

/**
 * The script that carries a repository's memory: `restore` at boot, before the
 * agent starts, and an upload after every turn (`hookScript` starts it on Stop
 * and SessionEnd, in the background, so it never slows the agent).
 *
 * Restore first, always: an upload is the whole memory as the box has it, and
 * a box that could not fetch the stored copy would replace it with whatever it
 * happened to hold. So nothing is uploaded until a restore has succeeded in
 * this session (`memory-restored`). A box whose stamp matches the stored one
 * keeps its own copy, which is at least as new; any other is replaced whole.
 * Nothing stored but a stamp kept means the person cleared it, so the box's
 * copy goes too.
 *
 * Every path is checked again here before a file is written, though Polaris
 * only stores what passed `parseMemoryUpload`.
 */
export function memorySyncScript(paths: MemorySyncPaths): string {
    const mark = `${paths.memoryDir}.synced`;
    return [
        "#!/bin/sh",
        "# Written by Polaris. Keeps this repository's agent memory with its owner, on any machine.",
        `mem=${shellQuote(paths.memoryDir)}`,
        `hand=${shellQuote(paths.handoffDir)}`,
        `root=${shellQuote(paths.workdir)}`,
        `mark=${shellQuote(mark)}`,
        `url=${shellQuote(paths.url)}`,
        `auth=${shellQuote(`Authorization: Bearer ${paths.token}`)}`,
        'state="$(cd "$(dirname "$0")" && pwd)"',
        'tab="$(printf "\\t")"',
        "umask 077",
        // The handoff pages whose recorded root is this checkout.
        "ours() {",
        '  for j in "$hand"/*.json; do',
        '    [ -f "$j" ] || continue',
        '    grep -qF "\\"root\\": \\"$root\\"" "$j" || continue',
        '    basename "$j" .json',
        "  done",
        "}",
        "wipe() {",
        '  rm -rf "$mem"',
        '  for n in $(ours); do rm -f "$hand/$n.json" "$hand/$n.md"; done',
        "}",
        'if [ "$1" = "restore" ]; then',
        '  got="$state/memory-restore.$$"',
        '  if ! curl -sS -f -m 30 -H "$auth" "$url" -o "$got" 2>/dev/null; then',
        '    rm -f "$got"',
        '    echo "polaris: this repository\'s memory could not be fetched, so this session keeps it on this machine only"',
        "    exit 0",
        "  fi",
        '  stamp="$(head -n 1 "$got")"',
        '  case "$stamp" in updated=[0-9]*) ;; *) rm -f "$got"; exit 0 ;; esac',
        '  if [ "$stamp" = "updated=0" ]; then',
        '    if [ -f "$mark" ]; then wipe; rm -f "$mark"; fi',
        '  elif [ ! -f "$mark" ] || [ "$(cat "$mark")" != "$stamp" ]; then',
        "    wipe",
        '    tail -n +2 "$got" | while IFS="$tab" read -r rel data; do',
        '      case "$rel" in *..*|*[!A-Za-z0-9._/-]*) continue ;; esac',
        '      case "$rel" in',
        '        memory/?*) dest="$mem/${rel#memory/}" ;;',
        '        handoff/?*) n="${rel#handoff/}"; case "$n" in */*) continue ;; esac; dest="$hand/$n" ;;',
        "        *) continue ;;",
        "      esac",
        '      mkdir -p "$(dirname "$dest")"',
        '      printf %s "$data" | base64 -d > "$dest" 2>/dev/null || rm -f "$dest"',
        "    done",
        '    mkdir -p "$(dirname "$mark")"',
        '    printf %s "$stamp" > "$mark"',
        '    echo "polaris: restored what the agent remembers about this repository"',
        "  fi",
        '  rm -f "$got"',
        '  : > "$state/memory-restored"',
        "  exit 0",
        "fi",
        '[ -f "$state/memory-restored" ] || exit 0',
        "list() {",
        '  if [ -d "$mem" ]; then',
        `    (cd "$mem" && find . -type f 2>/dev/null) | sed 's|^\\./||' | while IFS= read -r rel; do`,
        '      printf "memory/%s\\t%s/%s\\n" "$rel" "$mem" "$rel"',
        "    done",
        "  fi",
        "  for n in $(ours); do",
        '    printf "handoff/%s.json\\t%s/%s.json\\n" "$n" "$hand" "$n"',
        '    [ -f "$hand/$n.md" ] && printf "handoff/%s.md\\t%s/%s.md\\n" "$n" "$hand" "$n"',
        "  done",
        "}",
        'body="$state/memory-body.$$"',
        "{",
        "  printf '{\"files\":['",
        "  list | {",
        "    sep=''",
        "    total=0",
        "    count=0",
        '    while IFS="$tab" read -r rel abs; do',
        '      case "$rel" in *..*|*[!A-Za-z0-9._/-]*) continue ;; esac',
        '      size=$(wc -c < "$abs" 2>/dev/null | tr -d " ")',
        '      [ -n "$size" ] || continue',
        `      [ "$size" -le ${MEMORY_FILE_MAX_BYTES} ] || continue`,
        `      [ $((total + size)) -le ${MEMORY_TOTAL_MAX_BYTES} ] || continue`,
        `      [ "$count" -lt ${MEMORY_MAX_FILES} ] || break`,
        "      total=$((total + size))",
        "      count=$((count + 1))",
        `      printf '%s{"path":"%s","data":"' "$sep" "$rel"`,
        "      base64 < \"$abs\" | tr -d '\\n'",
        "      printf '\"}'",
        "      sep=','",
        "    done",
        "  }",
        "  printf ']}'",
        '} > "$body"',
        // The same memory as last time is not sent again: this runs after
        // every turn, and most turns change nothing here.
        'sum="$(cksum < "$body")"',
        'if [ -f "$state/memory-sent" ] && [ "$(cat "$state/memory-sent")" = "$sum" ]; then rm -f "$body"; exit 0; fi',
        'answer="$(curl -sS -f -m 30 -X POST "$url" -H "$auth" -H "Content-Type: application/json" --data-binary @"$body" 2>/dev/null)"',
        "rc=$?",
        'rm -f "$body"',
        '[ "$rc" = "0" ] || exit 0',
        'printf %s "$sum" > "$state/memory-sent"',
        'case "$answer" in updated=[0-9]*) mkdir -p "$(dirname "$mark")"; printf %s "$answer" > "$mark" ;; esac',
        "exit 0",
        ""
    ].join("\n");
}
