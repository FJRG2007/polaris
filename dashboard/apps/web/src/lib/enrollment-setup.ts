/**
 * Whether a freshly enrolled machine is set up to serve its own domains right
 * away, without anybody pressing the button on its page.
 *
 * Only a server - a runner has no domains to serve, and the box Polaris runs on
 * already has its edge. Only Linux, which is what the setup installs for. And
 * only with root, which the setup cannot do without.
 */

import type { ClaimEnrollmentInput } from "@polaris/core";

export function setsUpOnEnrollment(
    kind: string,
    payload: Pick<ClaimEnrollmentInput, "platform" | "root">
): boolean {
    return kind === "server" && payload.platform === "linux" && payload.root;
}
