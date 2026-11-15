/**
 * One home per stored account, for a tool that keeps its sign-in in a file.
 *
 * Claude Code takes its subscription token from a variable, so moving a
 * session to another account is a different value in the credentials file
 * the launch reads (`refreshCredentials`). Codex keeps its ChatGPT sign-in in
 * `auth.json` inside its home and refreshes that file itself, so a session
 * that swapped the file's contents on every switch would hand back a copy
 * whose refresh token Codex already spent. Instead every account gets a home
 * of its own, where its `auth.json` lives and keeps whatever Codex last wrote
 * to it, and the launch points the tool at it (`CODEX_HOME`). Everything else
 * in the home - the conversations a resume needs, the config, the hooks
 * Polaris installed - is a link back to the session's own home, so moving a
 * session between accounts resumes the same conversation.
 *
 * Ported from Agent Orchestrator (Apache-2.0),
 * backend/internal/adapters/agentaccount/codex.go and share.go: the private
 * and shared entry lists and the "an account's own copy is never replaced"
 * rule. Polaris differs in one place: the stored sign-in is copied in again
 * when its owner linked the account anew, told apart by a digest of what was
 * last copied, so a fresh login beats a refused one.
 *
 * Pure: `refreshCredentials` runs the script.
 */

import { createHash } from "node:crypto";

export interface AccountHome {
    /** The variable that moves the tool's home. */
    readonly env: string;
    /** The tool's own home, relative to the user's home. */
    readonly dir: string;
    /** The sign-in file, relative to the tool's home. */
    readonly file: string;
    /** Directories shared even before the tool made them. */
    readonly shared: readonly string[];
    /** Files shared even before the tool wrote them. */
    readonly sharedFiles: readonly string[];
    /** Entries that stay the account's own. */
    readonly private: readonly string[];
    /** Runtime locks a link replaces. */
    readonly replaceable: readonly string[];
}

/** Codex, from AO's `codexKnownShared`, `codexKnownSharedFiles`,
 *  `codexPrivate` and `codexReplaceable`. */
const CODEX: AccountHome = {
    env: "CODEX_HOME",
    dir: ".codex",
    file: "auth.json",
    shared: [
        "sessions",
        "archived_sessions",
        "sqlite",
        "shell_snapshots",
        "worktrees",
        "skills",
        "plugins",
        "cache",
        "logs",
        "mcp-oauth-locks",
        "thread-writer-locks"
    ],
    sharedFiles: ["config.toml", "history.jsonl"],
    private: [
        "auth.json",
        "models_cache.json",
        "log",
        "memories",
        "tmp",
        ".tmp",
        "app-server-control",
        "app-server-daemon",
        "ipc",
        ".codex-global-state.json",
        ".codex-global-state.json.bak"
    ],
    replaceable: ["mcp-oauth-locks", ".sqlite-maintenance.lock"]
};

const HOMES: Readonly<Record<string, AccountHome>> = { codex: CODEX };

/** Where Polaris keeps the account homes, relative to the user's home. */
export const ACCOUNTS_DIR = ".polaris-accounts";
/** The digest of the stored sign-in last copied into an account's home. */
export const STORED_MARK = ".polaris-stored";

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PART_NAME = /^account\.[a-f0-9]{8,64}\.part$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

/** The account home a tool takes, or null for a tool that signs in by variable. */
export function accountHomeFor(cliId: string): AccountHome | null {
    return HOMES[cliId] ?? null;
}

/** Every variable an account home may set, so a credentials file clears them. */
export function accountHomeEnvs(): string[] {
    return [...new Set(Object.values(HOMES).map((home) => home.env))];
}

/** The account's own home for a tool. Throws on an id that is not one. */
export function accountHomeDir(userHome: string, cliId: string, accountId: string): string {
    if (!SAFE_PATH.test(userHome)) throw new Error("That is not a home Polaris can use.");
    if (!ACCOUNT_ID.test(accountId)) throw new Error("That is not an account Polaris stores.");
    if (!accountHomeFor(cliId)) throw new Error("That tool keeps no account home.");
    return `${userHome}/${ACCOUNTS_DIR}/${cliId}/${accountId}`;
}

/** What is written beside an account home's sign-in, to tell a new login from
 *  one the tool refreshed. Hex, never the value. */
export function storedDigest(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The script that prepares an account's home and puts its sign-in in place,
 * from a file already written into the state directory as `part`. Carries no
 * credential, so it can travel as an argument. Exits 0 without doing anything
 * where the user's home is not there.
 */
export function accountHomeCommand(input: {
    readonly cliId: string;
    readonly userHome: string;
    readonly accountId: string;
    readonly stateDir: string;
    readonly part: string;
    readonly digest: string;
}): string {
    const home = accountHomeFor(input.cliId);
    if (!home) throw new Error("That tool keeps no account home.");
    if (!PART_NAME.test(input.part)) throw new Error("That is not a sign-in file Polaris wrote.");
    if (!SAFE_PATH.test(input.stateDir)) throw new Error("That is not a state directory Polaris uses.");
    if (!/^[a-f0-9]{64}$/.test(input.digest)) throw new Error("That is not a digest.");
    const dir = accountHomeDir(input.userHome, input.cliId, input.accountId);
    const skip = [...home.private, STORED_MARK].join("|");
    const replace = home.replaceable.join("|");
    return [
        `h="${input.userHome}"`,
        `s="$h/${home.dir}"`,
        `a="${dir}"`,
        `p="${input.stateDir}/${input.part}"`,
        'if [ ! -d "$h" ]; then rm -f "$p"; exit 0; fi',
        "umask 077",
        'mkdir -p "$s" "$a" || { rm -f "$p"; exit 1; }',
        `for n in ${home.shared.join(" ")}; do [ -e "$s/$n" ] || [ -L "$s/$n" ] || mkdir -p "$s/$n"; done`,
        `for n in ${home.sharedFiles.join(" ")}; do [ -e "$s/$n" ] || [ -L "$s/$n" ] || : > "$s/$n"; done`,
        'for e in "$s"/* "$s"/.[!.]*; do',
        '  [ -e "$e" ] || [ -L "$e" ] || continue',
        '  n="${e##*/}"',
        `  case "$n" in ${skip}) continue ;; esac`,
        '  [ -L "$a/$n" ] && continue',
        // An empty directory the tool made in a fresh home, or a runtime lock,
        // gives way to the link; anything else is the account's own copy.
        `  if [ -d "$a/$n" ] && [ -z "$(ls -A "$a/$n" 2>/dev/null)" ]; then rm -rf "$a/$n"; fi`,
        `  case "$n" in ${replace}) rm -rf "$a/$n" ;; esac`,
        '  [ -e "$a/$n" ] || ln -s "$e" "$a/$n"',
        "done",
        // The stored sign-in goes in when the home has none, or when its owner
        // linked the account again since it was last copied; otherwise the
        // copy the tool refreshed stays.
        `if [ ! -s "$a/${home.file}" ] || [ "$(cat "$a/${STORED_MARK}" 2>/dev/null)" != "${input.digest}" ]; then`,
        `  mv "$p" "$a/${home.file}" && printf %s "${input.digest}" > "$a/${STORED_MARK}" || { rm -f "$p"; exit 1; }`,
        "else",
        '  rm -f "$p"',
        "fi",
        `chmod 0600 "$a/${home.file}" 2>/dev/null || true`,
        `o="$(stat -c %u:%g "$h" 2>/dev/null)"`,
        `[ -n "$o" ] && chown -R -h "$o" "$h/${ACCOUNTS_DIR}" 2>/dev/null || true`
    ].join("\n");
}
