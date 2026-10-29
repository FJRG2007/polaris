/**
 * Bring the VPN's access up to date in the background, after an account's
 * standing changed (promoted, demoted, banned, closed, deleted).
 *
 * The service is loaded lazily so the account code does not pull the VPN's
 * whole module graph in, and never awaited so a slow engine never holds up
 * the change that caused it. `refreshVpnAccess` already catches its own
 * failures; the catch here is for the load itself, which would otherwise be
 * an unhandled rejection.
 *
 * Server-only.
 */
export function refreshVpnAccessLater(): void {
    void import("./service")
        .then((vpn) => vpn.refreshVpnAccess())
        .catch((error: unknown) =>
            console.error("polaris: the VPN's access was not brought up to date:", error)
        );
}
