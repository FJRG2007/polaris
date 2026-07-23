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
    const { syncAppRoutes, reconcileNasMounts } = await import("./lib/deploy-service");
    void syncAppRoutes().catch((error) => console.error("polaris: initial route sync failed:", error));

    // Migrate any quick tunnel still forwarding straight to an app's port onto the edge,
    // so its traffic is logged (and future restarts leave an edge tunnel untouched).
    const { reconcileQuickTunnels } = await import("./lib/deploy/quick-tunnel-service");
    void reconcileQuickTunnels().catch((error) => console.error("polaris: quick-tunnel reconcile failed:", error));

    // Re-establish NAS volume mounts a host reboot dropped, restarting any app whose
    // mount had to be re-created - so a NAS-backed volume survives reboots like a real
    // docker volume. Best-effort; a routine restart keeps live mounts and is a no-op.
    void reconcileNasMounts().catch((error) => console.error("polaris: initial NAS mount reconcile failed:", error));

    // Mint (once) an internal CA + leaf for the LAN hostnames and hand the leaf to
    // Traefik as its default certificate, so polaris.local can be trusted HTTPS
    // once the operator installs the root. Best-effort: a failure keeps the
    // self-signed default and never blocks startup.
    const { ensureLocalCa } = await import("./lib/local-ca-service");
    void ensureLocalCa().catch((error) => console.error("polaris: local CA setup failed:", error));

    // Vercel-style auto-deploy: poll connected GitHub repos and redeploy on a new
    // commit. Works without a public webhook (LAN installs can't receive one).
    const { startAutoDeployPoller } = await import("./lib/deploy/auto-deploy-poller");
    startAutoDeployPoller();

    // Keep a configured DuckDNS record pointed at the current public IP so a free
    // dynamic-DNS wildcard base stays reachable as the ISP IP changes.
    const { startDuckDnsSync } = await import("./lib/domain-service");
    startDuckDnsSync();

    // Probe each deployed-app domain so a subdomain that resolves but does not
    // actually serve is flagged as down in the UI, instead of shown as a live link.
    const { startDomainHealthPoller } = await import("./lib/watch/domain-health-poller");
    startDomainHealthPoller();

    // Evaluate Watch alarms (CPU/memory spikes, service/domain down) against recent
    // metrics and health, firing notifications on state transitions.
    const { startAlarmEvaluator } = await import("./lib/watch/alarm-evaluator");
    startAlarmEvaluator();
}
