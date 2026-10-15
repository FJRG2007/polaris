/**
 * SFTP accounts that reach one deployed service's volumes.
 *
 * Pure by design: the account schema, and how a set of accounts becomes the
 * environment and boot script of the small server container that answers them.
 * Nothing here starts anything; the dashboard hands the result to the runtime.
 *
 * Every account is chrooted to `/srv`, where each of the service's volumes is
 * mounted by its name, and is forced into the SFTP subsystem: no shell, no
 * forwarding, no way out of those folders. A read-only account gets the same
 * subsystem with writes refused (`internal-sftp -R`).
 */

import { z } from "zod";

/**
 * The image the server runs, pinned to a digest so a republished tag cannot
 * change what holds the account passwords. Pulled on the first account, never before.
 */
export const FILE_ACCESS_IMAGE = "atmoz/sftp:alpine@sha256:7e439fabeae536fa254340724c042e11999924d906417dbb5c73602ad518813f";

/** Where the service's volumes appear to an account. */
export const FILE_ACCESS_ROOT = "/srv";

/** The host ports servers are given from, one per service, before probing. */
export const FILE_ACCESS_PORTS = { from: 42200, to: 42999 } as const;

/** Names the image or the system already use. */
const RESERVED_USERNAMES = new Set([
    "root",
    "admin",
    "daemon",
    "bin",
    "sys",
    "sshd",
    "nobody",
    "operator",
    "ftp",
    "mail",
    "news",
    "games",
    "guest"
]);

/** One OpenSSH public key line: type, base64 body, optional comment. */
const PUBLIC_KEY =
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]{0,200})?$/;

/** Trim, and collapse a key pasted over several lines into one. */
export function normalizePublicKey(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

export const fileAccessUsernameSchema = z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_-]{2,31}$/, "Use 3 to 32 lowercase letters, digits, - or _, starting with a letter.")
    .refine((name) => !RESERVED_USERNAMES.has(name), "That name is kept for the system. Pick another.");

export const fileAccessAccountSchema = z
    .object({
        username: fileAccessUsernameSchema,
        // No newline: the boot script reads one account per line.
        password: z
            .string()
            .max(128, "Use at most 128 characters.")
            .refine((value) => !/[\r\n\0]/.test(value), "A password cannot contain a line break.")
            .optional()
            .transform((value) => (value ? value : undefined))
            .refine((value) => value === undefined || value.length >= 12, "Use at least 12 characters."),
        publicKey: z
            .string()
            .max(4000, "That key is too long.")
            .optional()
            .transform((value) => (value ? normalizePublicKey(value) : undefined))
            .refine((value) => value === undefined || PUBLIC_KEY.test(value), "That is not an OpenSSH public key line."),
        readOnly: z.boolean().default(false)
    })
    .refine((account) => account.password !== undefined || account.publicKey !== undefined, {
        message: "Give a password, a public key, or both.",
        path: ["password"]
    })
    .refine((account) => !account.password || !account.password.toLowerCase().includes(account.username), {
        message: "The password cannot contain the username.",
        path: ["password"]
    });

export type FileAccessAccountInput = z.input<typeof fileAccessAccountSchema>;
export type FileAccessAccount = z.output<typeof fileAccessAccountSchema>;

/** What the boot script needs of one account. */
export interface FileAccessLogin {
    readonly username: string;
    readonly password?: string;
    readonly publicKey?: string;
    readonly readOnly: boolean;
}

/** A folder name for a volume under `/srv`: its name, made safe for a path. */
export function fileAccessFolder(name: string): string {
    const safe = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
    return safe || "volume";
}

/** Folder names for each volume, unique, in the order given. */
export function fileAccessFolders(names: readonly string[]): string[] {
    const used = new Set<string>();
    return names.map((name) => {
        const base = fileAccessFolder(name);
        let folder = base;
        for (let index = 2; used.has(folder); index++) folder = `${base}-${index}`;
        used.add(folder);
        return folder;
    });
}

/** Base64 of UTF-8 text, in the browser and on the server alike. */
function b64(value: string): string {
    let binary = "";
    for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/**
 * The accounts as one environment value: base64 of one line per account,
 * `name<TAB>ro|rw<TAB>base64(password)<TAB>base64(key)`. Base64 twice over so
 * no value carries a control character into the container's environment.
 */
export function fileAccessAccountsEnv(logins: readonly FileAccessLogin[]): string {
    const lines = logins.map((login) =>
        [
            login.username,
            login.readOnly ? "ro" : "rw",
            login.password ? b64(login.password) : "-",
            login.publicKey ? b64(login.publicKey) : "-"
        ].join("\t")
    );
    return b64(lines.join("\n"));
}

/**
 * The script the container runs in place of the image's own entrypoint.
 *
 * Accounts take the owner of the first volume's folder as their user and
 * group, so what they upload is the service's own to read and write. Host keys
 * live on a volume of the server's own, so a client never sees the key change
 * when the server is started again.
 */
export const FILE_ACCESS_BOOT_SCRIPT = [
    "set -eu",
    'ROOT="/srv"',
    "KEYS=/etc/ssh/polaris-keys",
    "AUTH=/etc/ssh/polaris-authorized",
    "CONF=/etc/ssh/polaris_sshd_config",
    'mkdir -p "$KEYS" "$AUTH" /run/sshd /var/run/sshd',
    '[ -f "$KEYS/ssh_host_ed25519_key" ] || ssh-keygen -q -t ed25519 -N "" -f "$KEYS/ssh_host_ed25519_key"',
    '[ -f "$KEYS/ssh_host_rsa_key" ] || ssh-keygen -q -t rsa -b 3072 -N "" -f "$KEYS/ssh_host_rsa_key"',
    'chmod 600 "$KEYS"/ssh_host_*_key',
    'chown root:root "$ROOT"',
    'chmod 755 "$ROOT"',
    'FIRST="$ROOT/${POLARIS_FIRST_FOLDER:-}"',
    'if [ -n "${POLARIS_FIRST_FOLDER:-}" ] && [ -d "$FIRST" ]; then OWNER_UID=$(stat -c %u "$FIRST"); OWNER_GID=$(stat -c %g "$FIRST"); else OWNER_UID=1000; OWNER_GID=1000; fi',
    'ALLOW=""',
    'READONLY=""',
    'echo "$POLARIS_SFTP_ACCOUNTS" | base64 -d > /tmp/polaris-accounts',
    'echo >> /tmp/polaris-accounts',
    "while IFS=\"$(printf '\\t')\" read -r NAME MODE PASS KEY; do",
    '  [ -n "$NAME" ] || continue',
    '  sed -i "/^$NAME:/d" /etc/passwd /etc/shadow /etc/group 2>/dev/null || true',
    '  echo "$NAME:x:$OWNER_UID:$OWNER_GID::/:/sbin/nologin" >> /etc/passwd',
    '  echo "$NAME:*:19000:0:99999:7:::" >> /etc/shadow',
    '  if [ "$PASS" != "-" ]; then printf "%s:%s\\n" "$NAME" "$(echo "$PASS" | base64 -d)" | chpasswd; fi',
    '  rm -f "$AUTH/$NAME"',
    '  if [ "$KEY" != "-" ]; then echo "$KEY" | base64 -d > "$AUTH/$NAME"; echo >> "$AUTH/$NAME"; chmod 644 "$AUTH/$NAME"; fi',
    '  ALLOW="$ALLOW $NAME"',
    '  if [ "$MODE" = "ro" ]; then READONLY="${READONLY:+$READONLY,}$NAME"; fi',
    "done < /tmp/polaris-accounts",
    "rm -f /tmp/polaris-accounts",
    "{",
    '  echo "Port 22"',
    '  echo "HostKey $KEYS/ssh_host_ed25519_key"',
    '  echo "HostKey $KEYS/ssh_host_rsa_key"',
    '  echo "AllowUsers$ALLOW"',
    '  if [ "$OWNER_UID" = "0" ]; then echo "PermitRootLogin yes"; else echo "PermitRootLogin no"; fi',
    '  echo "PasswordAuthentication yes"',
    '  echo "KbdInteractiveAuthentication no"',
    '  echo "PubkeyAuthentication yes"',
    '  echo "AuthorizedKeysFile $AUTH/%u"',
    '  echo "X11Forwarding no"',
    '  echo "AllowTcpForwarding no"',
    '  echo "AllowAgentForwarding no"',
    '  echo "PermitTunnel no"',
    '  echo "Subsystem sftp internal-sftp"',
    '  echo "ChrootDirectory $ROOT"',
    '  echo "ForceCommand internal-sftp -d /${POLARIS_FIRST_FOLDER:-}"',
    '  if [ -n "$READONLY" ]; then echo "Match User $READONLY"; echo "  ForceCommand internal-sftp -R -d /${POLARIS_FIRST_FOLDER:-}"; fi',
    '} > "$CONF"',
    'exec /usr/sbin/sshd -D -e -f "$CONF"'
].join("\n");

/** The compose project a service's SFTP server runs under. */
export function fileAccessProject(appHash: string): string {
    return `polaris-sftp-${appHash}`;
}

/** The first port to try for a service: stable for its id, inside the range. */
export function fileAccessPortFor(seed: number): number {
    const span = FILE_ACCESS_PORTS.to - FILE_ACCESS_PORTS.from + 1;
    return FILE_ACCESS_PORTS.from + (Math.abs(seed) % span);
}

/** The next port after `port`, wrapping inside the range. */
export function nextFileAccessPort(port: number): number {
    return port >= FILE_ACCESS_PORTS.to ? FILE_ACCESS_PORTS.from : port + 1;
}
