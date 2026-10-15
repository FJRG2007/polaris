/**
 * What a new machine runs on its first boot.
 *
 * A shell script is a valid cloud-init user-data document (cloud-init runs one
 * that starts with `#!`), and it is also what Google's guest environment runs as
 * a `startup-script`, so one rendering serves every provider. It does only what
 * enrollment needs: an SSH server, curl, a container engine for `--docker` to
 * grant, and then the same enrollment command an operator would paste by hand.
 *
 * cloud-init user-data formats: https://cloudinit.readthedocs.io/en/latest/explanation/format.html
 *
 * Pure.
 */

/**
 * The only command shape accepted, the one `enrollmentCommand` builds: a URL
 * with no quote, space or shell character in it, piped into `sh` with the two
 * grants. Anything else is refused rather than embedded in a root script.
 */
const ENROLL_COMMAND =
    /^curl -sSL https?:\/\/[A-Za-z0-9.\-:[\]]+(\/[A-Za-z0-9._~\-/]*)? \| sudo sh -s -- --docker --root$/;

/** Where the script marks a finished enrollment, so a later boot does nothing. */
export const ENROLLED_MARK = "/var/lib/polaris-cloud-enrolled";

export function renderFirstBoot(enrollCommand: string): string {
    if (!ENROLL_COMMAND.test(enrollCommand)) {
        throw new Error("The enrollment command is not one Polaris builds");
    }
    return `#!/bin/sh
# Polaris: prepare this machine and add it to Polaris as a server.
set -eu
if [ -e ${ENROLLED_MARK} ]; then
    exit 0
fi
if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    apt-get install -y -q curl ca-certificates sudo openssh-server docker.io
    systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd >/dev/null 2>&1 || true
    systemctl enable --now docker >/dev/null 2>&1 || true
fi
${enrollCommand}
touch ${ENROLLED_MARK}
`;
}
