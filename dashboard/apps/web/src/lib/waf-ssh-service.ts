/**
 * The other door: failed SSH and SFTP logins on the servers Polaris manages.
 *
 * A machine with port 22 open collects thousands of credential attempts a day and not
 * one of them touches the web edge, so the HTTP jails would never see them. This
 * reads each server's own auth log over the SSH connection Polaris already holds,
 * runs the same jail engine over it, and bans the addresses that earned it.
 *
 * Enforcement has two halves, because a ban means two different things here:
 *
 *   - At the edge, through the usual snapshot, so a banned address also loses HTTP.
 *   - On the server itself, in its own firewall, because that is the only thing that
 *     can refuse a TCP connection to sshd. This needs root, which enrollment grants
 *     only when it was asked for - so a server without it still contributes its
 *     attempts and still gets the address banned everywhere else, and says so rather
 *     than pretending the ban reached sshd.
 */

import type { Client } from "ssh2";
import { prisma } from "@polaris/db";
import { getWafJails } from "@/lib/waf-ban-service";
import { getHostConnection } from "@/lib/host-service";
import { execCommand, openSshClient } from "@polaris/ssh";
import { authAttemptsAsEntries, detectWafBans, parseAuthFailures } from "@polaris/core";
import { recordWafBan, publishWafIntel, wafTrustedAddresses } from "@/lib/waf-intel-service";

/** One authenticated session to a host, for the two commands this makes. Opened per
 *  pass rather than pooled: the pass runs every few minutes and holding a connection
 *  open to every server in between costs each of them a session for nothing. */
async function connect(hostId: string, ownerId: string): Promise<Client> {
    const connection = await getHostConnection(hostId, ownerId);
    return openSshClient({
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        pinnedHostKey: connection.hostKey
    });
}

/**
 * Where the auth log lives, in the order they are tried. journalctl first because a
 * systemd host may keep nothing on disk at all; the plain files cover Debian/Ubuntu
 * (auth.log) and RHEL/SUSE (secure). `2>/dev/null` on each so a missing file is an
 * empty answer rather than noise on stderr, and the whole thing is one command so it
 * costs one round trip per host.
 */
const READ_AUTH_LOG = [
    "journalctl -u ssh -u sshd --since '-30 min' --no-pager -o short-iso 2>/dev/null",
    "tail -n 4000 /var/log/auth.log 2>/dev/null",
    "tail -n 4000 /var/log/secure 2>/dev/null"
].join("; ");

/** Cap on what one host can contribute per pass, so a machine under a heavy sweep
 *  cannot pull the whole loop's memory up with it. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Read one host's auth log. Returns null when the host cannot be reached, which is
 *  a fact about the host and not an error worth failing the pass over. */
async function readAuthLog(client: Client): Promise<string | null> {
    try {
        const chunks: Buffer[] = [];
        let size = 0;
        await execCommand(client, READ_AUTH_LOG, {
            onStdout: (chunk) => {
                if (size >= MAX_LOG_BYTES) return;
                size += chunk.length;
                chunks.push(chunk);
            }
        });
        return Buffer.concat(chunks).toString("utf8");
    } catch {
        return null;
    }
}

/**
 * Drop an address in the host's own firewall, so the ban actually reaches sshd.
 *
 * nftables first and iptables as the fallback, which between them covers every
 * distribution Polaris enrolls. The rule is inserted, not appended, so it sits ahead
 * of whatever ACCEPT the machine already has. Idempotent: adding the same address
 * twice is checked for rather than duplicated, because this runs every pass.
 *
 * Returns whether it landed, so the caller can record a ban that reached the edge but
 * not the server rather than reporting a protection that is not there.
 */
async function blockAtHost(client: Client, sudo: boolean, ip: string): Promise<boolean> {
    if (!sudo) return false;
    // The address is interpolated into a shell script, and it came out of a log the
    // remote machine wrote - which is exactly the kind of input that must not be
    // trusted to be well formed. Anything but an address is refused outright rather
    // than escaped, because there is no legitimate value here that this rejects.
    if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return false;

    const script = [
        "set -e",
        "if command -v nft >/dev/null 2>&1; then",
        "  sudo nft list table inet polaris >/dev/null 2>&1 || sudo nft add table inet polaris",
        "  sudo nft list chain inet polaris input >/dev/null 2>&1 || sudo nft 'add chain inet polaris input { type filter hook input priority -10 ; policy accept ; }'",
        `  sudo nft list chain inet polaris input | grep -q '${ip} drop' || sudo nft add rule inet polaris input ip saddr ${ip} drop`,
        "elif command -v iptables >/dev/null 2>&1; then",
        `  sudo iptables -C INPUT -s ${ip} -j DROP 2>/dev/null || sudo iptables -I INPUT -s ${ip} -j DROP`,
        "else",
        "  exit 3",
        "fi"
    ].join("\n");

    try {
        // Fed on stdin rather than as a command line: sshd runs the command through a
        // login shell, where it would be visible in `ps` to every user on the machine.
        const result = await execCommand(client, "sh -s", { input: script });
        return result.code === 0;
    } catch {
        return false;
    }
}

/** The other direction: take the address back out of the host's own firewall. Same
 *  two backends, same refusal to interpolate anything that is not an address, and
 *  the same tolerance for a rule that is not there - lifting a ban twice has to be
 *  as harmless as lifting one that never landed. */
async function unblockAtHost(client: Client, sudo: boolean, ip: string): Promise<boolean> {
    if (!sudo) return false;
    if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return false;

    const script = [
        "if command -v nft >/dev/null 2>&1; then",
        "  handle=$(sudo nft -a list chain inet polaris input 2>/dev/null |",
        `    grep '${ip} drop' | grep -oE 'handle [0-9]+' | awk '{print $2}')`,
        "  for h in $handle; do sudo nft delete rule inet polaris input handle $h; done",
        "fi",
        "if command -v iptables >/dev/null 2>&1; then",
        `  while sudo iptables -C INPUT -s ${ip} -j DROP 2>/dev/null; do`,
        `    sudo iptables -D INPUT -s ${ip} -j DROP || break`,
        "  done",
        "fi",
        "exit 0"
    ].join("\n");

    try {
        const result = await execCommand(client, "sh -s", { input: script });
        return result.code === 0;
    } catch {
        return false;
    }
}

/**
 * Take an address out of every enrolled machine's firewall.
 *
 * Lifting a ban used to mean deleting a row and republishing the snapshot the edge
 * reads, which is only where half of a ban lives: the SSH jail also drops the
 * address in the host's own kernel firewall, and nothing ever took that back out. So
 * an address cleared in Polaris went on being refused by the machine itself - the
 * web console said it was allowed, sshd and everything else on that host disagreed,
 * and the difference is invisible from the dashboard. A ban with no expiry at the
 * kernel is also a ban that outlives its own `until`.
 *
 * Best-effort per host and never fatal: a machine that is off or unreachable must not
 * stop the ban being lifted everywhere else, and the sweep re-applies a block that is
 * genuinely still earned.
 */
export async function liftHostBlocks(ip: string): Promise<{ hosts: number; lifted: number }> {
    const hosts = await prisma.host.findMany({ select: { id: true, ownerId: true, sudo: true } });
    let lifted = 0;
    for (const host of hosts) {
        if (!host.sudo) continue;
        let client: Client;
        try {
            client = await connect(host.id, host.ownerId);
        } catch {
            continue;
        }
        try {
            if (await unblockAtHost(client, host.sudo, ip)) lifted += 1;
        } finally {
            client.end();
        }
    }
    return { hosts: hosts.length, lifted };
}

/**
 * One pass over every managed server.
 *
 * Hosts are read one at a time rather than in parallel: this is background
 * maintenance against machines that may be small, and opening an SSH session to all
 * of them at once is a worse neighbour than taking a few seconds longer.
 */
export async function runSshJails(now = Date.now()): Promise<{ hosts: number; banned: number }> {
    const jails = (await getWafJails()).filter((jail) => jail.id === "ssh-auth" && jail.enabled);
    if (jails.length === 0) return { hosts: 0, banned: 0 };

    const ignore = await wafTrustedAddresses();
    // Every enrolled server, whoever owns it. This is instance-wide protection, not
    // one account's, so it is scoped by the instance rather than by a caller - there
    // is no caller, it runs on a timer.
    const hosts = await prisma.host.findMany({ select: { id: true, name: true, ownerId: true, sudo: true } });
    let banned = 0;
    let reached = 0;

    for (const host of hosts) {
        let client: Client | null = null;
        try {
            client = await connect(host.id, host.ownerId);
        } catch {
            // Unreachable, credentials rotated, key changed. A fact about the host,
            // not a reason to abandon the others.
            continue;
        }
        try {
            reached += 1;
            const raw = await readAuthLog(client);
            if (!raw) continue;
            const attempts = parseAuthFailures(raw, now);
            if (attempts.length === 0) continue;

            const verdicts = detectWafBans({
                entries: authAttemptsAsEntries(attempts),
                jails,
                ignore,
                priorBans: await priorSshOffences(attempts.map((attempt) => attempt.ip)),
                now
            });

            for (const verdict of verdicts) {
                const atHost = await blockAtHost(client, host.sudo, verdict.ip);
                await recordWafBan({
                    ip: verdict.ip,
                    reason: "ban",
                    source: "ssh-auth",
                    note: atHost
                        ? `${verdict.note} on ${host.name}`
                        : `${verdict.note} on ${host.name} (edge only - Polaris has no root there)`,
                    until: verdict.until === null ? null : new Date(verdict.until)
                });
                banned += 1;
            }
        } finally {
            try {
                client.end();
            } catch {
                // Already gone.
            }
        }
    }

    if (banned > 0) await publishWafIntel();
    return { hosts: reached, banned };
}

/** Times each of these addresses has been banned before, so a machine that comes
 *  back tomorrow is held longer than one that turned up once. */
async function priorSshOffences(ips: readonly string[]): Promise<Record<string, number>> {
    const unique = [...new Set(ips)];
    if (unique.length === 0) return {};
    const rows = await prisma.wafBan.findMany({
        where: { ip: { in: unique } },
        select: { ip: true, offences: true }
    });
    return Object.fromEntries(rows.map((row) => [row.ip, row.offences]));
}
