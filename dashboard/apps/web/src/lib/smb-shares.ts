/**
 * SMB share discovery. Uses smbclient (bundled in the image) to enumerate the
 * shares a host exposes for a given account, so the UI can offer them to pick
 * instead of asking the user to type a share name. Credentials are passed via a
 * 0600 auth file, never on the command line, since process arguments are visible
 * in the host's process list. Server-only (spawns a process).
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Enumerate the non-administrative SMB shares on a host for the given account. */
export async function listSmbShares(host: string, username: string, password: string): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), "polaris-smb-"));
    const authFile = join(dir, "auth");
    try {
        await writeFile(authFile, `username=${username}\npassword=${password}\n`, { mode: 0o600 });
        const stdout = await new Promise<string>((resolve, reject) => {
            execFile(
                "smbclient",
                ["-L", `//${host}`, "-A", authFile, "-g", "-m", "SMB3"],
                { timeout: 12_000 },
                (error, out, err) => {
                    // `smbclient -L` can exit non-zero yet still print the shares,
                    // so prefer stdout when it carries a listing.
                    if (out && out.includes("Disk|")) {
                        resolve(out);
                    } else {
                        reject(new Error((err || error?.message || "smbclient failed").toString().trim()));
                    }
                }
            );
        });
        const shares: string[] = [];
        for (const line of stdout.split("\n")) {
            if (line.startsWith("Disk|")) {
                const name = line.split("|")[1]?.trim();
                // Skip administrative/hidden shares (IPC$, print$, ...).
                if (name && !name.endsWith("$")) shares.push(name);
            }
        }
        return shares;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
