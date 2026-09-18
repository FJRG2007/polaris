/**
 * The host port an app publishes on, derived from its id.
 *
 * Its own module because the deploy service around it reaches the database, the
 * container runtime and the filesystem, and this is arithmetic: it is asked for
 * while drawing a screen, and by the installable apps, which take it from the
 * host.
 */

import { shortHash } from "@polaris/deploy";

/** A stable host port (20000-39999) for an app, derived from its id so it is
 *  collision-resistant and consistent across redeploys without a schema column. */
export function hostPortForApp(id: string): number {
    return 20000 + (parseInt(shortHash(id, 4), 16) % 20000);
}
