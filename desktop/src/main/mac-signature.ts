/**
 * Whether this macOS app is signed with a Developer ID, which Squirrel.Mac
 * requires before it replaces an app: it checks the update against the running
 * app's signature, and an unsigned or ad-hoc signed app (every arm64 build is
 * ad-hoc signed at least) has no team to check it against.
 */

import { execFile } from "node:child_process";

/** The team in `codesign --display --verbose` output, or null when the
 *  signature names none (ad-hoc, or unsigned). */
export function teamIdentifier(output: string): string | null {
    const match = /^TeamIdentifier=(\S+)\s*$/m.exec(output);
    const team = match?.[1];
    return team && team !== "not set" ? team : null;
}

function codesign(args: readonly string[]): Promise<string | null> {
    return new Promise((done) => {
        execFile("/usr/bin/codesign", [...args], { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) =>
            done(error ? null : `${stdout}${stderr}`)
        );
    });
}

/** Whether the bundle's signature is valid and carries a team. */
export async function developerSigned(bundle: string): Promise<boolean> {
    if ((await codesign(["--verify", "--strict", bundle])) === null) return false;
    const details = await codesign(["--display", "--verbose=2", bundle]);
    return details !== null && teamIdentifier(details) !== null;
}
