/**
 * Reading failed access attempts out of an SSH server's own log.
 *
 * The HTTP jails watch the edge's request log; this watches the other door. A machine
 * exposed on port 22 collects thousands of credential-stuffing attempts a day, and
 * none of them ever touch the web edge, so nothing the WAF sees would ever ban them.
 *
 * sshd says the same things in several shapes depending on version, whether the user
 * exists, and how far the attempt got. All of them are counted the same way, because
 * they mean the same thing: someone tried to get in and did not.
 *
 * Pure: given log text, produce attempts. Fetching it is the caller's problem, which
 * is what makes this testable against real log samples rather than against a mock of
 * a remote shell.
 */

/** One failed attempt, in the shape the jail engine already understands. */
export interface AuthAttempt {
    /** ISO-8601 when derivable, else null - an entry that cannot be placed in time
     *  cannot be counted against a window. */
    readonly time: string | null;
    readonly ip: string;
    /** The account that was tried, where the log names one. Reported so an operator
     *  can tell a typo on their own account from a sweep through "admin", "oracle",
     *  "test". */
    readonly user: string | null;
    /** ssh | sftp - which service refused it. */
    readonly service: "ssh" | "sftp";
}

/**
 * The lines that mean "refused". Each captures the address, and the account where
 * the line carries one.
 *
 * `Connection closed by authenticating user` is included because that is what a
 * client trying key after key produces, and it is the single most common shape of an
 * automated sweep - leaving it out would miss most of what this is for.
 */
const PATTERNS: readonly { readonly re: RegExp; readonly user: number | null; readonly ip: number }[] = [
    { re: /Failed password for (?:invalid user )?(\S+) from (\S+) port \d+/, user: 1, ip: 2 },
    { re: /Failed publickey for (?:invalid user )?(\S+) from (\S+) port \d+/, user: 1, ip: 2 },
    { re: /Invalid user (\S+) from (\S+)(?: port \d+)?/, user: 1, ip: 2 },
    { re: /Connection closed by authenticating user (\S+) (\S+) port \d+/, user: 1, ip: 2 },
    { re: /Connection reset by authenticating user (\S+) (\S+) port \d+/, user: 1, ip: 2 },
    { re: /error: maximum authentication attempts exceeded for (?:invalid user )?(\S+) from (\S+) port \d+/, user: 1, ip: 2 },
    { re: /Disconnected from authenticating user (\S+) (\S+) port \d+/, user: 1, ip: 2 },
    { re: /Connection closed by invalid user (\S+) (\S+) port \d+/, user: 1, ip: 2 },
    // No account named: an address that was refused before it got that far.
    { re: /Did not receive identification string from (\S+)/, user: null, ip: 1 },
    { re: /banner exchange: Connection from (\S+) port \d+: invalid format/, user: null, ip: 1 },
    { re: /Bad protocol version identification .* from (\S+)/, user: null, ip: 1 }
];

/** An "authentication failure" line from PAM, which names the address separately. */
const PAM_FAILURE = /authentication failure;.*rhost=(\S+)(?:\s+user=(\S+))?/;

/** A syslog stamp with no year ("Aug  2 21:04:11"), the traditional auth.log shape. */
const SYSLOG_STAMP = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/;
/** journalctl -o short-iso and rsyslog's RFC-5424 both start with a full stamp. */
const ISO_STAMP = /^(\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/;
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** sftp runs over ssh, so a refused sftp session is an sshd line. The subsystem is
 *  only named once a session exists, which is after auth - so an attempt is
 *  attributed to sftp when the line says so and to ssh otherwise. */
function serviceOf(line: string): "ssh" | "sftp" {
    return /sftp/i.test(line) ? "sftp" : "ssh";
}

/**
 * Parse an auth log into failed attempts.
 *
 * `now` anchors the year for syslog stamps, which do not carry one. A line stamped
 * in December read in January belongs to the previous year, and getting that wrong
 * would place a whole month of attempts outside every jail window.
 */
export function parseAuthFailures(raw: string, now = Date.now()): AuthAttempt[] {
    if (!raw) return [];
    const attempts: AuthAttempt[] = [];
    for (const line of raw.split("\n")) {
        if (line === "") continue;
        const found = matchLine(line);
        if (!found) continue;
        attempts.push({ time: stampOf(line, now), ip: stripPort(found.ip), user: found.user, service: serviceOf(line) });
    }
    return attempts;
}

function matchLine(line: string): { ip: string; user: string | null } | null {
    for (const pattern of PATTERNS) {
        const match = pattern.re.exec(line);
        if (!match) continue;
        const ip = match[pattern.ip];
        if (!ip) continue;
        return { ip, user: pattern.user === null ? null : (match[pattern.user] ?? null) };
    }
    const pam = PAM_FAILURE.exec(line);
    if (pam?.[1]) return { ip: pam[1], user: pam[2] ?? null };
    return null;
}

/** An address may arrive as "1.2.3.4" or "::ffff:1.2.3.4"; normalise the mapped form
 *  so it matches what the rest of the firewall stores. */
function stripPort(value: string): string {
    return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function stampOf(line: string, now: number): string | null {
    const iso = ISO_STAMP.exec(line);
    if (iso?.[1]) {
        const parsed = new Date(iso[1].replace(" ", "T"));
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    const syslog = SYSLOG_STAMP.exec(line);
    if (!syslog) return null;
    const month = MONTHS.indexOf(syslog[1]!);
    if (month < 0) return null;
    const reference = new Date(now);
    // Same year, unless that would put the entry in the future - which means the log
    // rolled over and the line belongs to last year.
    let year = reference.getUTCFullYear();
    let date = new Date(
        Date.UTC(year, month, Number(syslog[2]), Number(syslog[3]), Number(syslog[4]), Number(syslog[5]))
    );
    if (date.getTime() > now + 24 * 3600 * 1000) {
        year -= 1;
        date = new Date(
            Date.UTC(year, month, Number(syslog[2]), Number(syslog[3]), Number(syslog[4]), Number(syslog[5]))
        );
    }
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Attempts as the jail engine consumes them. It counts `HttpLogLike` entries, and an
 * auth failure is the same event with a different origin, so it is presented as one
 * rather than growing a second engine that would drift from the first.
 *
 * The synthetic status is 401 (the auth-failed jail's own trigger) and the path names
 * the service, so a ban note reads "ssh" rather than a bare number.
 */
export function authAttemptsAsEntries(
    attempts: readonly AuthAttempt[]
): { time: string | null; ip: string; path: string; status: number }[] {
    return attempts.map((attempt) => ({
        time: attempt.time,
        ip: attempt.ip,
        path: `/${attempt.service}`,
        status: 401
    }));
}
