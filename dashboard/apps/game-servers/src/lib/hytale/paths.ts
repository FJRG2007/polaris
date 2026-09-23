/**
 * Where a Hytale server keeps its files, and what it answers on.
 *
 * Facts, kept apart from `service.ts` - which reads those files and therefore
 * reaches a container, the deploy stack and node's own crypto. The panel needs
 * the port and the shape of the answer, and importing either from the service
 * pulls that whole stack into the browser half of the bundle, where `node:crypto`
 * does not exist. That is not a warning, it is a build that fails, and a file of
 * constants is the cheapest way for it never to happen again.
 */

/** The manifest a Hytale server is created from. */
export const HYTALE_CATALOG_ID = "hytale";

/** Where the image looks for them, which is the top of the volume. */
export const HYTALE_ROOT = "/data";
export const HYTALE_JAR = `${HYTALE_ROOT}/HytaleServer.jar`;
export const HYTALE_ASSETS = `${HYTALE_ROOT}/Assets.zip`;

/** The port a Hytale client reaches a server on. QUIC, so UDP and nothing else. */
export const HYTALE_PORT = 5520;

export interface HytaleFiles {
    readonly jar: boolean;
    readonly assets: boolean;
    /**
     * Whether the answer is worth trusting.
     *
     * A container that is not up has its volumes read by borrowing them, which
     * works - but a machine that will not answer at all is a different thing from
     * a file that is not there, and a screen that turned one into "put your files
     * in" would be asking somebody to fix what is already correct.
     */
    readonly read: boolean;
}
