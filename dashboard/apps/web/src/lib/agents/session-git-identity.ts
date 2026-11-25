/**
 * Who the agent commits as.
 *
 * A machine Polaris made has no git identity of its own, so an agent asked to
 * commit found none and either signed as whoever the history named or stopped to
 * ask - and then told the person about it either way. The boot sets the
 * identity of the person the session works for, the way their own computer
 * already has it: their GitHub account where they linked one, their Polaris
 * account otherwise (with a no-reply address, never their own).
 *
 * Pure: the values are resolved in `session-git-identity-source.ts` and reach
 * the boot as environment variables (`POLARIS_GIT_NAME`, `POLARIS_GIT_EMAIL`,
 * `POLARIS_GIT_SCOPE`), never interpolated into a script.
 */

export interface GitIdentity {
    readonly name: string;
    readonly email: string;
}

/**
 * Where the boot writes the identity.
 *
 * - `global`: the home is Polaris's and this person's alone, so it goes in the
 *   home's own git config, which every repository the agent touches reads.
 * - `repo`: the home is shared between people, so only this session's checkout
 *   gets it - one person's name in a shared home would sign the next person's
 *   commits.
 * - `missing`: the machine is somebody's own server. Their git identity is
 *   theirs; the checkout gets this one only when the machine has none at all.
 */
export type GitIdentityScope = "global" | "repo" | "missing";

/** The address GitHub attributes to an account without publishing a real one. */
export function githubNoreplyEmail(id: string | number, login: string): string {
    return `${id}+${login}@users.noreply.github.com`;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** One line, no angle brackets (git's own delimiters around the address), and
 *  bounded. Empty when nothing is left. */
function cleanName(value: string | null | undefined): string {
    return (value ?? "")
        .replace(/[\u0000-\u001f\u007f<>]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
}

function cleanEmail(value: string | null | undefined): string {
    const email = (value ?? "").trim().toLowerCase();
    return email.length <= 254 && EMAIL.test(email) ? email : "";
}

/**
 * The identity a GitHub account commits as: its display name (its login when it
 * has none), and the address it chose to publish - which GitHub only allows for
 * a verified one - or else its noreply address, which GitHub ties to the account
 * without exposing anything. Null when the account's own fields are not the
 * shape GitHub gives them.
 */
export function identityFromGithub(account: {
    readonly id: string | number;
    readonly login: string;
    readonly name?: string | null;
    readonly email?: string | null;
}): GitIdentity | null {
    const id = String(account.id);
    if (!NUMERIC_ID.test(id) || !LOGIN.test(account.login)) return null;
    return {
        name: cleanName(account.name) || account.login,
        email: cleanEmail(account.email) || githubNoreplyEmail(id, account.login)
    };
}

/** Where an instance with no public hostname sends its no-reply addresses: a
 *  reserved name that can never resolve (RFC 2606), rather than a guessed one. */
export const NOREPLY_FALLBACK_HOST = "polaris.invalid";

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The address a Polaris account commits as when it has no GitHub linked: tied
 * to the account, on this instance's own public hostname, and never the
 * person's real address - a commit pushed to a public repository publishes its
 * author address for good. `host` is the instance's public hostname, or null
 * when it has none.
 */
export function polarisNoreplyEmail(userId: string, host: string | null): string | null {
    if (!USER_ID.test(userId)) return null;
    const domain = host && HOST.test(host.toLowerCase()) ? host.toLowerCase() : NOREPLY_FALLBACK_HOST;
    return `${userId.toLowerCase()}@users.noreply.${domain}`;
}

/** The identity of a Polaris account with no GitHub linked: its name, and its
 *  no-reply address (`polarisNoreplyEmail`), never its own. */
export function identityFromUser(
    user: { readonly id: string; readonly name: string } | null,
    host: string | null
): GitIdentity | null {
    if (!user) return null;
    const email = polarisNoreplyEmail(user.id, host);
    if (!email) return null;
    return { name: cleanName(user.name) || (email.split("@")[0] ?? email), email };
}

/** Where the boot leaves a mark once an identity is in place, which is what
 *  decides whether the agent is told about it (`GIT_PROMPT`). */
export const GIT_IDENTITY_MARK = "$POLARIS_STATE_DIR/git-identity";

/**
 * The boot's lines. After the worktree preparation, so the shell is inside the
 * checkout when there is one; best effort throughout, since the setup runs
 * under `set -e` and a commit without a name is still better than no session.
 * The values are only ever expanded inside double quotes.
 */
export const SET_GIT_IDENTITY: readonly string[] = [
    `rm -f "${GIT_IDENTITY_MARK}"`,
    'if [ -n "$POLARIS_GIT_NAME" ] && [ -n "$POLARIS_GIT_EMAIL" ]; then',
    '  git_set=""',
    '  in_repo=""',
    '  if [ -n "$GITHUB_REPOSITORY" ] && git rev-parse --git-dir >/dev/null 2>&1; then',
    "    in_repo=yes",
    "  fi",
    '  if [ "$POLARIS_GIT_SCOPE" = "global" ] && [ -n "$POLARIS_HOME" ]; then',
    '    git config --global user.name "$POLARIS_GIT_NAME" && git config --global user.email "$POLARIS_GIT_EMAIL" && git_set=yes || true',
    '    if [ "$POLARIS_AS_ROOT" = "yes" ]; then',
    '      chown "$POLARIS_RUNAS" "$HOME/.gitconfig" 2>/dev/null || true',
    "    fi",
    '  elif [ "$POLARIS_GIT_SCOPE" = "missing" ] && git config user.email >/dev/null 2>&1; then',
    // Somebody's own server, already signed: theirs stands.
    "    git_set=yes",
    '  elif [ -n "$in_repo" ]; then',
    '    git config user.name "$POLARIS_GIT_NAME" && git config user.email "$POLARIS_GIT_EMAIL" && git_set=yes || true',
    "  fi",
    '  if [ -n "$git_set" ]; then',
    `    : > "${GIT_IDENTITY_MARK}" 2>/dev/null || true`,
    "  fi",
    "fi"
];

/**
 * What the agent is told once its git is set up, so it commits without
 * narrating who it signs as. Carried inside one double-quoted argument on the
 * launch line, so it holds no double quote, dollar sign, backtick or backslash.
 */
export const GIT_PROMPT =
    "Git is already configured as the person you work for, the same way their own computer is: commit without setting, asking about or mentioning the author.";

/** Added where the session's GitHub CLI is set up (`INSTALL_GH`). */
export const GH_PROMPT =
    "The GitHub CLI (gh) and git push are already signed in for this repository: push and open pull requests directly, without asking about or mentioning credentials.";
