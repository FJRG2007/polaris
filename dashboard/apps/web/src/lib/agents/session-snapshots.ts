/**
 * Per-turn snapshots of a session's checkout, and undo/redo over them.
 *
 * The technique is OpenCode's (`packages/core/src/snapshot.ts`): a second git
 * repository whose work tree is the checkout and whose objects live apart from
 * the agent's own, so taking a snapshot never touches the branch, the index or
 * the history the agent and the pull request see. Here it is kept inside the
 * checkout's git directory (`.git/polaris-snapshots`), which git never adds to
 * a tree, and goes wherever the checkout goes.
 *
 * - Before each prompt Polaris sends, the checkout is added to that repository
 *   and written as a tree; the tree becomes a commit on `refs/polaris/turns`,
 *   one per turn, its subject the prompt's opening (base64) and its time the
 *   moment it was sent.
 * - Undo puts the files back the way they were before the newest turn - or
 *   before an older one somebody picked - after saving the checkout as it is on
 *   `refs/polaris/redo`. `refs/polaris/undone` names the turn the files stand
 *   before now.
 * - Redo walks forward again a turn at a time, and from the newest turn back to
 *   what was saved on `refs/polaris/redo`.
 * - The next prompt keeps the undo: the turns from the undone one on leave the
 *   chain, and the new turn follows the one before it.
 *
 * The checkout's ignore rules decide what a snapshot holds, so dependencies and
 * build output are neither saved nor put back. Every script answers in one
 * status line well under the daemon's 16 KiB cap.
 */

import { shellPath, shellQuote } from "./session-hooks";

const MARK = "polaris-snapshots:";

/** Where a container checkout lives when the row has none recorded. */
const DEFAULT_WORKDIR = "/session/repo";

/** Turns listed at most: 40 lines of a hash, a time and a short subject stay
 *  far below the daemon's cap. */
export const MAX_LISTED_TURNS = 40;

/** Characters of a prompt kept as its turn's label. */
export const LABEL_CHARS = 160;

/** The longest a snapshot may take before it is given up on, in seconds, so a
 *  huge checkout delays a prompt by this much at most. */
export const CAPTURE_TIMEOUT_S = 25;

/** How recent a turn with the same files has to be to stand for the prompt a
 *  hook reports, in seconds. */
export const SAME_TURN_WINDOW_S = 120;

const REF_TURNS = "refs/polaris/turns";
const REF_REDO = "refs/polaris/redo";
const REF_UNDONE = "refs/polaris/undone";

/** A commit name in a sha1 or sha256 repository. */
export const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function preamble(workdir: string): string[] {
    return [
        "export GIT_TERMINAL_PROMPT=0 GIT_LITERAL_PATHSPECS=1",
        "export GIT_AUTHOR_NAME=Polaris GIT_AUTHOR_EMAIL=snapshots@polaris.invalid",
        "export GIT_COMMITTER_NAME=Polaris GIT_COMMITTER_EMAIL=snapshots@polaris.invalid",
        `cd ${shellPath(workdir || DEFAULT_WORKDIR)} 2>/dev/null || { echo "${MARK} nocheckout"; exit 0; }`,
        "g() { git -c safe.directory='*' \"$@\"; }",
        `gd=$(g rev-parse --absolute-git-dir 2>/dev/null) || { echo "${MARK} nocheckout"; exit 0; }`,
        `top=$(g rev-parse --show-toplevel 2>/dev/null) || { echo "${MARK} nocheckout"; exit 0; }`,
        'cd "$top" || exit 0',
        'snap="$gd/polaris-snapshots"',
        "S() { git -c safe.directory='*' -c core.autocrlf=false -c core.quotePath=false -c gc.auto=256 --git-dir=\"$snap\" --work-tree=\"$top\" \"$@\"; }",
        // Brings the snapshot index level with the checkout. Only `.gitignore`
        // and the checkout's own `info/exclude` decide what is left out.
        'sync() { mkdir -p "$snap/info" && { cp "$(g rev-parse --git-path info/exclude)" "$snap/info/exclude" 2>/dev/null || : > "$snap/info/exclude"; } && S add -A -- . >/dev/null 2>&1; }'
    ];
}

/** Creates the snapshot repository when it is not there yet. */
const INIT = [
    'if [ ! -f "$snap/HEAD" ]; then',
    `  S init -q >/dev/null 2>&1 && S config core.bare false || { echo "${MARK} failed"; exit 0; }`,
    "fi"
];

/** Leaves the script when the session has no snapshot repository at all. */
const NEEDS_REPO = [`[ -f "$snap/HEAD" ] || { echo "${MARK} empty"; exit 0; }`];

/** The label a turn is stored under: the prompt's opening on one line. */
export function turnLabel(prompt: string): string {
    const line = prompt.replace(/\s+/g, " ").trim().slice(0, LABEL_CHARS);
    return Buffer.from(line, "utf8").toString("base64");
}

/**
 * The script that snapshots the checkout before a turn. When an undo is in
 * progress the turns from the undone one on are dropped first, which is what
 * makes the undo stick; the answer then says `kept` with the undone turn's
 * label, so the agent can be told.
 */
export function captureScript(input: { workdir: string; prompt: string }): string {
    return [
        ...preamble(input.workdir),
        ...INIT,
        `label=${shellQuote(turnLabel(input.prompt))}`,
        `sync || { echo "${MARK} failed"; exit 0; }`,
        `tree=$(S write-tree 2>/dev/null) || { echo "${MARK} failed"; exit 0; }`,
        `head=$(S rev-parse -q --verify ${REF_TURNS} 2>/dev/null)`,
        'kept=""',
        `if u=$(S rev-parse -q --verify ${REF_UNDONE} 2>/dev/null); then`,
        '  kept=$(S log -1 --format=%s "$u" 2>/dev/null)',
        '  head=$(S rev-parse -q --verify "$u^" 2>/dev/null)',
        `  S update-ref -d ${REF_REDO} >/dev/null 2>&1; S update-ref -d ${REF_UNDONE} >/dev/null 2>&1`,
        // The same files as a turn taken moments ago: the prompt a hook reports
        // is the one already snapshotted before Polaris sent it.
        'elif [ -n "$head" ] && [ "$(S log -1 --format=%T "$head" 2>/dev/null)" = "$tree" ] &&',
        `  [ $(( $(date +%s) - $(S log -1 --format=%ct "$head" 2>/dev/null || echo 0) )) -lt ${SAME_TURN_WINDOW_S} ]; then`,
        `  echo "${MARK} captured $head"; exit 0`,
        "fi",
        `c=$(printf '%s\\n' "$label" | S commit-tree "$tree" \${head:+-p "$head"} 2>/dev/null) || { echo "${MARK} failed"; exit 0; }`,
        `S update-ref ${REF_TURNS} "$c" >/dev/null 2>&1 || { echo "${MARK} failed"; exit 0; }`,
        "S gc --auto --quiet >/dev/null 2>&1",
        `if [ -n "$kept" ]; then echo "${MARK} kept $c $kept"; else echo "${MARK} captured $c"; fi`
    ].join("\n");
}

/** The script that lists the newest turns and where an undo stands. */
export function listTurnsScript(input: { workdir: string }): string {
    return [
        ...preamble(input.workdir),
        `[ -f "$snap/HEAD" ] || { echo "${MARK} list -"; exit 0; }`,
        `u=$(S rev-parse -q --verify ${REF_UNDONE} 2>/dev/null)`,
        `echo "${MARK} list \${u:--}"`,
        `S log -n ${MAX_LISTED_TURNS} --format='%H %ct %s' ${REF_TURNS} 2>/dev/null`
    ].join("\n");
}

/**
 * The script that steps back. With no `to` it puts the files back to before
 * the newest turn not yet undone; with `to` (a turn on the chain) to before that
 * turn. The checkout as it was before the first step back is saved, so redo can
 * always return to it.
 */
export function undoScript(input: { workdir: string; to?: string }): string {
    const to = input.to && COMMIT_PATTERN.test(input.to) ? input.to : "";
    return [
        ...preamble(input.workdir),
        ...NEEDS_REPO,
        `head=$(S rev-parse -q --verify ${REF_TURNS} 2>/dev/null) || { echo "${MARK} empty"; exit 0; }`,
        `u=$(S rev-parse -q --verify ${REF_UNDONE} 2>/dev/null)`,
        `to=${shellQuote(to)}`,
        'if [ -n "$to" ]; then',
        `  S merge-base --is-ancestor "$to" ${REF_TURNS} >/dev/null 2>&1 || { echo "${MARK} stale"; exit 0; }`,
        "  target=$to",
        'elif [ -n "$u" ]; then',
        `  target=$(S rev-parse -q --verify "$u^" 2>/dev/null) || { echo "${MARK} empty"; exit 0; }`,
        "else",
        "  target=$head",
        "fi",
        `sync || { echo "${MARK} failed"; exit 0; }`,
        'if [ -z "$u" ]; then',
        `  tree=$(S write-tree 2>/dev/null) || { echo "${MARK} failed"; exit 0; }`,
        `  r=$(echo redo | S commit-tree "$tree" 2>/dev/null) || { echo "${MARK} failed"; exit 0; }`,
        `  S update-ref ${REF_REDO} "$r" >/dev/null 2>&1 || { echo "${MARK} failed"; exit 0; }`,
        "fi",
        `S reset -q --hard "$target" >/dev/null 2>&1 || { echo "${MARK} failed"; exit 0; }`,
        `S update-ref ${REF_UNDONE} "$target" >/dev/null 2>&1 || { echo "${MARK} failed"; exit 0; }`,
        `echo "${MARK} undone $target"`
    ].join("\n");
}

/** The script that steps forward one turn, or back to the files as they were
 *  before the first undo once there is no turn left to step to. */
export function redoScript(input: { workdir: string }): string {
    return [
        ...preamble(input.workdir),
        ...NEEDS_REPO,
        `u=$(S rev-parse -q --verify ${REF_UNDONE} 2>/dev/null) || { echo "${MARK} empty"; exit 0; }`,
        `next=$(S rev-list --reverse --ancestry-path "$u..${REF_TURNS}" 2>/dev/null | head -n 1)`,
        `sync || { echo "${MARK} failed"; exit 0; }`,
        'if [ -n "$next" ]; then',
        `  S reset -q --hard "$next" >/dev/null 2>&1 || { echo "${MARK} failed"; exit 0; }`,
        `  S update-ref ${REF_UNDONE} "$next" >/dev/null 2>&1 || { echo "${MARK} failed"; exit 0; }`,
        `  echo "${MARK} undone $next"; exit 0`,
        "fi",
        `r=$(S rev-parse -q --verify ${REF_REDO} 2>/dev/null) || { echo "${MARK} failed"; exit 0; }`,
        `S reset -q --hard "$r" >/dev/null 2>&1 || { echo "${MARK} failed"; exit 0; }`,
        `S update-ref -d ${REF_UNDONE} >/dev/null 2>&1; S update-ref -d ${REF_REDO} >/dev/null 2>&1`,
        `echo "${MARK} restored"`
    ].join("\n");
}

// ---------------------------------------------------------------------------
// Reading the answers
// ---------------------------------------------------------------------------

export interface Turn {
    /** The snapshot commit taken before this turn. */
    readonly id: string;
    /** When the prompt that started it was sent, in epoch milliseconds. */
    readonly at: number;
    readonly label: string;
}

export interface TurnsListing {
    /** Newest first. */
    readonly turns: readonly Turn[];
    /** The turn the files stand before while an undo is in progress. */
    readonly undone: string | null;
}

function decodeLabel(encoded: string): string {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return "";
    return Buffer.from(encoded, "base64").toString("utf8").slice(0, LABEL_CHARS);
}

function statusLine(output: string): string[] | null {
    const line = output.split("\n").find((row) => row.startsWith(MARK));
    return line ? line.slice(MARK.length).trim().split(/\s+/) : null;
}

export function parseTurns(output: string): TurnsListing | null {
    const lines = output.split("\n");
    const start = lines.findIndex((line) => line.startsWith(MARK));
    if (start < 0) return null;
    const [status, undone] = lines[start]!.slice(MARK.length).trim().split(/\s+/);
    if (status !== "list") return null;
    const turns: Turn[] = [];
    for (const line of lines.slice(start + 1)) {
        const [id, at, label = ""] = line.trim().split(" ");
        if (!id || !COMMIT_PATTERN.test(id) || !at || !/^\d+$/.test(at)) continue;
        turns.push({ id, at: Number(at) * 1000, label: decodeLabel(label) });
        if (turns.length >= MAX_LISTED_TURNS) break;
    }
    return { turns, undone: undone && COMMIT_PATTERN.test(undone) ? undone : null };
}

export type CaptureResult =
    | { kind: "captured"; id: string }
    | { kind: "kept"; id: string; undoneLabel: string }
    | { kind: "nocheckout" }
    | { kind: "failed" };

export function parseCapture(output: string): CaptureResult | null {
    const words = statusLine(output);
    if (!words) return null;
    const [status, id = "", label = ""] = words;
    if (status === "nocheckout" || status === "failed") return { kind: status };
    if (!COMMIT_PATTERN.test(id)) return null;
    if (status === "captured") return { kind: "captured", id };
    if (status === "kept") return { kind: "kept", id, undoneLabel: decodeLabel(label) };
    return null;
}

export type StepResult =
    | { kind: "undone"; id: string }
    | { kind: "restored" }
    | { kind: "empty" }
    | { kind: "stale" }
    | { kind: "nocheckout" }
    | { kind: "failed" };

export function parseStep(output: string): StepResult | null {
    const words = statusLine(output);
    if (!words) return null;
    const [status, id = ""] = words;
    switch (status) {
        case "undone":
            return COMMIT_PATTERN.test(id) ? { kind: "undone", id } : null;
        case "restored":
        case "empty":
        case "stale":
        case "nocheckout":
        case "failed":
            return { kind: status };
        default:
            return null;
    }
}

/**
 * What the agent is told with the first prompt after an undo was kept. A coding
 * agent's own conversation cannot be cut from outside it, so the turns that
 * were undone are named instead, and the files already match.
 */
export function undoneNote(label: string): string {
    const said = label ? ` "${label}"` : "";
    return `[Polaris: the files in this checkout were put back to how they were before the message${said}. Treat that message and everything after it as undone.]`;
}
