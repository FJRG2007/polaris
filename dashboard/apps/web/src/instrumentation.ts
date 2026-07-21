/**
 * Server instrumentation. Installs last-resort guards so a faulty connector (an
 * SMB client that throws an async socket/crypto error, say) can never take the
 * whole dashboard down with an uncaught exception - the failing request errors,
 * the server stays up. Node runtime only; the edge runtime has no process events.
 */

export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    process.on("uncaughtException", (error) => {
        console.error("polaris: uncaught exception (server kept alive):", error);
    });
    process.on("unhandledRejection", (reason) => {
        console.error("polaris: unhandled rejection (server kept alive):", reason);
    });

    // Detect the edition and keep it live: probe polaris-hostd on startup and on
    // an interval, folding its capability report into the shared snapshot that
    // getCapabilities() serves. Without this the dashboard is stuck reporting the
    // limited edition even when the daemon is running.
    const { startCapabilityRefresh } = await import("@polaris/hostd-client");
    startCapabilityRefresh();

    // Sample consumption of deployed apps and Drive devices on an interval, so the
    // dashboard can chart history and not just the live value. Self-guarding: a bad
    // tick only logs. Skipped during the build (register runs at server start).
    const { startMetricsCollector } = await import("./lib/metrics-collector-service");
    startMetricsCollector();

    // Write the Traefik dynamic routes for deployed-app domains on startup, so the
    // edge self-heals after a restart or a fresh dynamic volume. Best-effort.
    const { syncAppRoutes } = await import("./lib/deploy-service");
    void syncAppRoutes().catch((error) => console.error("polaris: initial route sync failed:", error));

    // Vercel-style auto-deploy: poll connected GitHub repos and redeploy on a new
    // commit. Works without a public webhook (LAN installs can't receive one).
    const { startAutoDeployPoller } = await import("./lib/deploy/auto-deploy-poller");
    startAutoDeployPoller();
}
