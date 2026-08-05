/**
 * The one place the control plane borrows a connection to a machine from, so an
 * operation pays for a handshake only when there is nothing open to reuse.
 *
 * Why this exists: a Drive listing, a metrics probe or a Docker call is a few
 * milliseconds of work behind a handshake that costs hundreds - TCP, key exchange
 * and auth for SSH; TCP, negotiate, NTLM session setup, tree connect and a listing
 * of the whole share root for SMB. Opening one per request made browsing a machine
 * feel slow next to the same machine in any desktop file client, which logs in once
 * and keeps the session for as long as you are looking at it.
 *
 * Three things are borrowed here:
 *
 *   - The SSH connection, from `SshPool`. Leases keep a connection alive while
 *     anything is using it (a long download must not be reaped mid-transfer) and
 *     idle ones are closed after the pool's TTL, so a machine nobody is looking at
 *     is not holding a session open forever.
 *   - The SFTP channel, cached per connection. Opening one is a round trip, and it
 *     is safe to share: SFTP multiplexes by request id, which is how a client
 *     pipelines reads. The channel dies with its connection and is never closed by
 *     a borrower, so nobody can pull it out from under another request.
 *   - The SMB session, for a NAS read over SMB rather than through a kernel mount.
 *     Unlike ssh2 this client does not announce its own death, so a borrowed session
 *     is proved with one cheap `stat` of the share root and replaced when that
 *     fails - a round trip against a whole session setup.
 *
 * SSH connections are keyed by purpose AND machine. One connection per machine would
 * be tidier but sshd allows a bounded number of concurrent channels on a connection
 * (MaxSessions, 10 by default), and a screen that lists containers while probing
 * metrics while browsing files would push against it; a handful of connections
 * never does. An SMB session is keyed by storage connection, since that is what
 * carries the share and the account.
 */

import type { Client, SFTPWrapper } from "ssh2";
import { openSmbSession, type SmbConnectOptions, type SmbSession } from "@polaris/storage";
import { LeasePool, openSftp, openSshClient, SshPool, type SshConnectOptions, type SshLease } from "@polaris/ssh";

/**
 * What a connection is being borrowed for. Long-lived channels (a terminal, a
 * database tunnel) deliberately do NOT borrow: they hold a channel open for as long
 * as somebody is looking at them, and one that dies takes every other borrower's
 * work with it. Those keep opening their own connection.
 */
export type SshPurpose = "drive" | "exec" | "docker";

const pool = new SshPool();

/** SMB sessions, keyed by storage connection id. */
const smbPool = new LeasePool<SmbSession>((session) => session.disconnect());

/** Cached SFTP channel per pooled connection. A WeakMap so a connection the pool
 *  has dropped takes its channel entry with it. */
const channels = new WeakMap<Client, Promise<SFTPWrapper>>();

/** Borrow a connection to a machine. Release the lease when the work is done. */
export function borrowSsh(purpose: SshPurpose, machineId: string, options: SshConnectOptions): Promise<SshLease> {
    return pool.acquire(`${purpose}:${machineId}`, () => openSshClient(options));
}

/** A borrowed SFTP channel, and the release that gives its connection back. */
export interface SftpLease {
    readonly sftp: SFTPWrapper;
    release(): void;
}

/** Borrow an SFTP channel on a (possibly already open) connection to a machine. */
export async function borrowSftp(
    purpose: SshPurpose,
    machineId: string,
    options: SshConnectOptions
): Promise<SftpLease> {
    const lease = await borrowSsh(purpose, machineId, options);
    try {
        return { sftp: await channelOn(lease.client), release: () => lease.release() };
    } catch (error) {
        lease.release();
        throw error;
    }
}

/** A borrowed SMB session, and the release that gives it back. */
export interface SmbLease {
    readonly session: SmbSession;
    release(): void;
}

/**
 * Borrow an SMB session for a storage connection.
 *
 * The session is proved before it is handed over, with a `stat` of the share root:
 * one round trip, against the TCP connect, negotiate, session setup, tree connect and
 * full root listing that opening a new one costs. This client does not report its own
 * death - a NAS that rebooted leaves a session that looks fine and fails on use - so
 * without the check a pooled session could stay broken for as long as somebody kept
 * retrying.
 */
export async function borrowSmb(connectionId: string, options: Omit<SmbConnectOptions, "id">): Promise<SmbLease> {
    const key = `smb:${connectionId}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let opened = false;
        const lease = await smbPool.acquire(key, () => {
            opened = true;
            return openSmbSession(options);
        });
        // A session opened just now was already proved by `openSmbSession`; only one
        // that was lying around needs asking.
        if (opened) return { session: lease.value, release: () => lease.release() };
        try {
            await lease.value.stat("");
            return { session: lease.value, release: () => lease.release() };
        } catch (error) {
            // Only this session is given up on, and only while nothing else is using
            // it: a check can fail on a session another request is midway through a
            // download on, and by the time it does the pool may already hold a
            // replacement that has nothing wrong with it.
            const dead = lease.value;
            lease.release();
            smbPool.discard(key, dead);
            if (attempt === 1) throw error;
        }
    }
    // Unreachable: the loop either returns or throws on its second pass.
    throw new Error("Could not borrow an SMB session");
}

/**
 * Forget every connection to a machine, closing the idle ones now.
 *
 * Call this the moment a machine's credentials, address or host key change, or the
 * machine itself goes away: the next borrow then reconnects and re-reads the
 * credential instead of reusing a session opened with the old one.
 */
export function dropSshConnections(machineId: string): void {
    for (const purpose of ["drive", "exec", "docker"] satisfies SshPurpose[]) {
        pool.evict(`${purpose}:${machineId}`);
    }
}

/** The same for a stored storage connection (a NAS, an SFTP share), whose sessions
 *  are keyed by connection id rather than by machine. */
export function dropStorageConnection(connectionId: string): void {
    pool.evict(`drive:${connectionId}`);
    smbPool.evict(`smb:${connectionId}`);
}

/** The channel for a connection, opening one the first time. */
function channelOn(client: Client): Promise<SFTPWrapper> {
    const cached = channels.get(client);
    if (cached) return cached;
    const opening = openSftp(client).then((sftp) => {
        const forget = (): void => {
            if (channels.get(client) === opening) channels.delete(client);
        };
        // A channel closed by the far end (`end`), broken (`error`) or gone with its
        // connection must not be handed to the next borrower.
        sftp.once("end", forget);
        sftp.once("close", forget);
        sftp.once("error", forget);
        return sftp;
    });
    opening.catch(() => {
        if (channels.get(client) === opening) channels.delete(client);
    });
    channels.set(client, opening);
    return opening;
}
