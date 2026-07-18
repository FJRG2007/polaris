/**
 * Lightweight NAS reconnaissance. Given a host, probe the ports common NAS
 * devices expose and suggest the best connector, so adding a connection is a
 * matter of typing an IP and clicking Detect rather than knowing which protocol
 * to pick. This only opens TCP connections (no auth, no payload) and times out
 * fast; it never scans a range, only the host the operator entered.
 */

import { connect } from "node:net";
import type { StorageProviderKind } from "@polaris/core";

export interface NasDetection {
    readonly host: string;
    readonly services: {
        readonly ssh: boolean;
        readonly smb: boolean;
        readonly nfs: boolean;
        readonly webUi: boolean;
    };
    /** The connector to preselect, or null if nothing recognizable answered. */
    readonly suggested: StorageProviderKind | null;
    /** Human-readable summary of what answered. */
    readonly hints: string[];
}

/** True if a TCP connection to host:port completes before the timeout. */
function probePort(host: string, port: number, timeoutMs = 900): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host, port });
        const finish = (open: boolean) => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
    });
}

export async function detectHost(host: string): Promise<NasDetection> {
    const target = host.trim();
    const [ssh, smb, nfs, http, https, synology, qnap] = await Promise.all([
        probePort(target, 22),
        probePort(target, 445),
        probePort(target, 2049),
        probePort(target, 80),
        probePort(target, 443),
        probePort(target, 5000),
        probePort(target, 8080)
    ]);

    const webUi = http || https || synology || qnap;
    const hints: string[] = [];
    if (ssh) hints.push("SSH");
    if (smb) hints.push("SMB");
    if (nfs) hints.push("NFS");
    if (webUi) hints.push("web dashboard");

    // Prefer a userspace connector that works without the host daemon: a vendor
    // API if its port is open, then SFTP (SSH), then SMB, then NFS.
    let suggested: StorageProviderKind | null = null;
    if (synology) suggested = "synology";
    else if (qnap) suggested = "qnap";
    else if (ssh) suggested = "sftp";
    else if (smb) suggested = "smb";
    else if (nfs) suggested = "nfs";

    return { host: target, services: { ssh, smb, nfs, webUi }, suggested, hints };
}
