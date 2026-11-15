/**
 * Why a NAS share does not answer: the device is there but its file sharing
 * refuses, or nothing answers at that address at all.
 *
 * The two have different fixes, and "check that the device is on" is wrong for
 * the first: a NAS rebooting, or one whose SMB service was switched off, answers
 * on its other ports while refusing the file-sharing one. So the file-sharing
 * port and the device are asked separately, each with a short timeout, and only
 * positive evidence decides: a refusal is somebody answering, silence is nobody.
 *
 * Server-only.
 */

import { connect } from "node:net";

/** What a share's silence turned out to be. */
export type ShareCause =
    /** The device answers, but its file-sharing port refuses or stays silent. */
    | "sharing-off"
    /** Nothing answers at that address, or there is no route to it. */
    | "host-down";

/** One knock's wait. A NAS on the same network answers in milliseconds. */
export const SHARE_PROBE_MS = 2500;

/** File-sharing ports, by connection kind. */
const SHARING_PORTS: Record<string, number> = { smb: 445, nfs: 2049 };

/** Ports a NAS commonly answers on besides file sharing: its web admin and SSH.
 *  A refusal on any of them proves the device is up just as well as an answer. */
const DEVICE_PORTS = [80, 443, 22, 5000] as const;

type Knock = "open" | "refused" | "silent" | "unreachable" | "error";

/** One TCP connect, saying how it ended. */
export function knock(host: string, port: number, timeoutMs = SHARE_PROBE_MS): Promise<Knock> {
    return new Promise((resolve) => {
        const socket = connect({ host, port, timeout: timeoutMs });
        const settle = (outcome: Knock): void => {
            socket.destroy();
            resolve(outcome);
        };
        socket.once("connect", () => settle("open"));
        socket.once("timeout", () => settle("silent"));
        socket.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "ECONNREFUSED") settle("refused");
            else if (error.code === "ETIMEDOUT") settle("silent");
            else if (error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH" || error.code === "EHOSTDOWN")
                settle("unreachable");
            else settle("error");
        });
    });
}

/** The file-sharing port for a connection kind, or null when it has none here. */
export function sharingPort(kind: string): number | null {
    return SHARING_PORTS[kind] ?? null;
}

/**
 * Why the share at `host` does not answer, or null when its file-sharing port
 * does (the fault is then the sign-in or the share name, not the device) or the
 * address could not be asked at all (it does not resolve).
 */
export async function diagnoseShare(
    host: string,
    port: number,
    timeoutMs = SHARE_PROBE_MS
): Promise<ShareCause | null> {
    const sharing = await knock(host, port, timeoutMs);
    if (sharing === "open" || sharing === "error") return null;
    if (sharing === "refused") return "sharing-off";
    if (sharing === "unreachable") return "host-down";
    const device = await Promise.all(DEVICE_PORTS.map((other) => knock(host, other, timeoutMs)));
    return device.some((outcome) => outcome === "open" || outcome === "refused") ? "sharing-off" : "host-down";
}

/** The host of a mount source: `//host/share` for SMB, `host:/path` for NFS. */
export function mountSourceHost(kind: string, source: string): string | null {
    if (kind === "smb") {
        const match = /^[\\/]{2}([^\\/]+)/.exec(source.trim());
        return match?.[1] ?? null;
    }
    if (kind === "nfs") {
        const trimmed = source.trim();
        const bracketed = /^\[([^\]]+)\]:/.exec(trimmed);
        if (bracketed) return bracketed[1]!;
        const colon = trimmed.indexOf(":");
        return colon > 0 ? trimmed.slice(0, colon) : null;
    }
    return null;
}
