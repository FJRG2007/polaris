/**
 * The vault's own wording for the short code a client shows and somebody types
 * back, and what a waiting request looks like to the person deciding on it.
 *
 * What a code IS lives in `lib/device-code`, which the browser extension's own
 * connection uses as well: two flows that each invented an alphabet would be two
 * flows whose codes cannot be told apart by anyone reading one off a screen.
 * Re-exported here so every caller that already asks this module keeps doing so.
 *
 * Apart from the service that stores these (`lib/vault/authorization`) because
 * the screen that approves one is a client component: anything it imports is
 * bundled for the browser, and that service imports Prisma.
 *
 * Everything in this file is pure. No database, no request, no clock.
 */

export {
    AUTHORIZATION_POLL_MS,
    AUTHORIZATION_TTL_MS,
    formatUserCode,
    newUserCode,
    readUserCode
} from "@/lib/device-code";

/** A waiting request, as the person deciding on it is shown it. */
export interface PendingAuthorization {
    readonly userCode: string;
    /** What the client called itself. A label, never a decision. */
    readonly device: string;
    /** The address it asked from, when it was recorded. */
    readonly requestIp: string | null;
    /** Which of this deployment's names it asked on. */
    readonly host: string | null;
    /** The public half the key would be sealed to, so the screen approving can do
     *  the sealing without a second round trip. */
    readonly publicKey: string;
    readonly requestedAt: string;
    readonly expiresAt: string;
}
