/**
 * SSH hardening: what the status read says, and whether turning password
 * sign-in off is safe on this server. Pure, so the rules can be asserted in a
 * test.
 *
 * Safe means somebody can still get in afterwards with a key: on a server
 * Polaris reaches over SSH, Polaris's own login must be a key (the confirm that
 * keeps the change travels over a fresh one); everywhere, at least one account
 * that can log in must have a key. Accounts that only have a password are
 * listed, since they stop being able to sign in over SSH.
 */

export type SshState = "on" | "armed" | "off" | "unavailable";

/** An account that can log in, as the status read found it. */
export interface SshAccount {
    readonly name: string;
    readonly keys: number;
    readonly password: boolean;
}

/** A key in an account's `authorized_keys`, as the status read printed it. An
 *  older host service's read prints none. */
export interface SshKeyLine {
    readonly account: string;
    readonly type: string;
    /** The key's base64 blob, which is what a fingerprint is taken of. */
    readonly blob: string;
    readonly comment: string;
}

export interface SshReport {
    readonly state: SshState;
    /** Whether sshd accepts a password today; null when it did not say. */
    readonly passwordLogin: boolean | null;
    /** sshd's effective `permitrootlogin`; null when it did not say. */
    readonly rootLogin: string | null;
    readonly accounts: readonly SshAccount[];
    readonly keys: readonly SshKeyLine[];
}

const STATES: readonly SshState[] = ["on", "armed", "off", "unavailable"];
const MAX_ACCOUNTS = 200;
const MAX_KEYS = 400;
const ACCOUNT = /^[A-Za-z0-9._-]{1,64}$/;
// Options may precede the type and hold quoted spaces, so the key is found by
// its type rather than by position.
const KEY_LINE = /(?:^|\s)((?:ssh-|ecdsa-|sk-)[A-Za-z0-9@._-]{1,64})\s+([A-Za-z0-9+/]{16,}={0,2})(?:\s+(.*))?$/;

/** One `POLARIS_KEY=<account> <authorized_keys line>`, or null. Pure. */
export function parseKeyLine(rest: string): SshKeyLine | null {
    const space = rest.indexOf(" ");
    if (space <= 0) return null;
    const account = rest.slice(0, space);
    if (!ACCOUNT.test(account)) return null;
    const match = KEY_LINE.exec(rest.slice(space + 1));
    if (!match) return null;
    const [, type = "", blob = "", comment = ""] = match;
    // eslint-disable-next-line no-control-regex
    const clean = comment.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
    return { account, type, blob, comment: clean };
}

function value(line: string, key: string): string | null {
    return line.startsWith(`${key}=`) ? line.slice(key.length + 1).trim() : null;
}

/** The status read, or null when the output is not one. */
export function parseSshLog(output: string): SshReport | null {
    let state: SshState | null = null;
    let passwordLogin: boolean | null = null;
    let rootLogin: string | null = null;
    let kbd: boolean | null = null;
    const accounts: SshAccount[] = [];
    const keys: SshKeyLine[] = [];
    for (const raw of output.split("\n")) {
        const line = raw.trim();
        const word = value(line, "POLARIS_SSH");
        if (word && (STATES as readonly string[]).includes(word)) state = word as SshState;
        const sshd = value(line, "POLARIS_SSHD");
        if (sshd) {
            const [key = "", setting = ""] = sshd.split(/\s+/);
            if (key === "passwordauthentication") passwordLogin = setting === "yes";
            if (key === "kbdinteractiveauthentication" || key === "challengeresponseauthentication") {
                kbd = (kbd ?? false) || setting === "yes";
            }
            if (key === "permitrootlogin" && /^[a-z-]{1,32}$/.test(setting)) rootLogin = setting;
        }
        const account = value(line, "POLARIS_ACCOUNT");
        if (account && accounts.length < MAX_ACCOUNTS) {
            const [name = "", keys = "", password = ""] = account.split(/\s+/);
            if (ACCOUNT.test(name) && /^\d{1,6}$/.test(keys)) {
                accounts.push({ name, keys: Number(keys), password: password === "yes" });
            }
        }
        const key = value(line, "POLARIS_KEY");
        const parsed = key && keys.length < MAX_KEYS ? parseKeyLine(key) : null;
        if (parsed) keys.push(parsed);
    }
    if (!state) return null;
    // Keyboard-interactive is a password prompt too, as far as a guesser is concerned.
    const anyPassword = passwordLogin === null && kbd === null ? null : Boolean(passwordLogin || kbd);
    return { state, passwordLogin: anyPassword, rootLogin, accounts, keys };
}

export type SshBlocker = "unavailable" | "passwordLogin" | "noKeys";

export interface SshPlan {
    readonly blocked: SshBlocker | null;
    /** Already key-only, whoever made it so. */
    readonly hardened: boolean;
    /** Accounts with a key, which keep signing in. */
    readonly keyed: readonly string[];
    /** Accounts with only a password, which stop signing in over SSH. */
    readonly loses: readonly string[];
}

export function planSsh(
    report: SshReport,
    context: { readonly local: boolean; readonly polarisAuth: string | null }
): SshPlan {
    const keyed = report.accounts.filter(({ keys }) => keys > 0).map(({ name }) => name);
    const loses = report.accounts
        .filter(({ keys, password }) => keys === 0 && password)
        .map(({ name }) => name);
    const hardened = report.passwordLogin === false && report.rootLogin !== "yes";
    let blocked: SshBlocker | null = null;
    if (report.state === "unavailable") blocked = "unavailable";
    else if (!context.local && context.polarisAuth !== "key") blocked = "passwordLogin";
    else if (keyed.length === 0) blocked = "noKeys";
    return { blocked, hardened, keyed, loses };
}

export type SshStep = "review" | null;

/** What the pass does: tell the owner once that a server still takes
 *  passwords and the review waits on them. Never applies by itself. */
export function sshStep(
    setting: { readonly sshChoice: string | null; readonly sshNotifiedAt: Date | null } | null,
    view: { readonly state: SshState; readonly plan: SshPlan }
): SshStep {
    if (view.plan.blocked || view.plan.hardened || view.state !== "off") return null;
    return !setting?.sshChoice && !setting?.sshNotifiedAt ? "review" : null;
}

export type SshEnding =
    | "armed"
    | "confirmed"
    | "rolled-back"
    | "unavailable"
    | "nokeys"
    | "invalid"
    | "overridden"
    | "failed"
    | "unknown"
    | "off";

const ENDINGS: readonly SshEnding[] = [
    "armed",
    "confirmed",
    "rolled-back",
    "unavailable",
    "nokeys",
    "invalid",
    "overridden",
    "failed",
    "unknown",
    "off"
];

export function parseSshEnding(output: string): SshEnding | null {
    for (const raw of output.split("\n")) {
        const word = value(raw.trim(), "POLARIS_SSH");
        if (word && (ENDINGS as readonly string[]).includes(word)) return word as SshEnding;
    }
    return null;
}
