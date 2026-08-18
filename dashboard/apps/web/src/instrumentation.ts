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
    const { syncAppRoutes, reconcileNasMounts, recoverAbandonedDeployments } = await import("./lib/deploy-service");
    const { guardVacantReachable } = await import("./lib/deploy/router");
    void syncAppRoutes()
        .then(async () => {
            // The edge guard container starts alongside this one and nothing sequences
            // the two, so this first sync can easily run before it answers. What that
            // writes is a valid config missing only the routers for a hostname with
            // nothing on it - and since routes are otherwise resynced by deploys and
            // domain edits, on a host that is simply left running it would stay missing.
            // So the sync is repeated once the guard has had time to come up. It is
            // idempotent; a repeat that was not needed costs one file write.
            if (await guardVacantReachable()) return;
            setTimeout(() => {
                void syncAppRoutes().catch((error) =>
                    console.error("polaris: the route resync for the edge guard failed:", error)
                );
            }, 30_000).unref();
        })
        .catch((error) => console.error("polaris: initial route sync failed:", error));

    // Close out deploys this process cannot possibly be running: the deploy queue is
    // in memory, so anything left mid-flight by the previous process is abandoned, and
    // a row that still reads DEPLOYING is one an operator waits on instead of retrying.
    void recoverAbandonedDeployments().catch((error) =>
        console.error("polaris: could not close out interrupted deploys:", error)
    );

    // Same for the dashboard's own public hostnames, which the compose labels cannot
    // carry: they are fixed at `up` time, so a domain configured afterwards would only
    // reach the edge again the next time it was saved.
    //
    // The call server's path goes out with them, from inside that same function:
    // it rides these hostnames and carries their allowlist, so the two must not
    // be written by two callers racing on one directory Traefik watches.
    //
    // Retried once, which neither of the others needs: both files are read from
    // the database, and the one carrying the call route is the only way a browser
    // can reach the media server at all - so a database that is still starting
    // here means every call fails at the first WebSocket until somebody happens
    // to save a domain. The same thirty seconds the guard resync waits.
    const { syncDashboardRoute } = await import("./lib/domain-edge");
    void syncDashboardRoute().then((written) => {
        if (written) return;
        setTimeout(() => void syncDashboardRoute(), 30_000).unref();
    });

    // Migrate any quick tunnel still forwarding straight to an app's port onto the edge,
    // so its traffic is logged (and future restarts leave an edge tunnel untouched).
    const { reconcileQuickTunnels } = await import("./lib/deploy/quick-tunnel-service");
    void reconcileQuickTunnels().catch((error) => console.error("polaris: quick-tunnel reconcile failed:", error));

    // And the server's own tunnel, for the same reason: a connector raised against an
    // origin that has since changed keeps running and forwards into nothing. Only one
    // whose origin no longer matches is recreated, so a healthy tunnel keeps its URL.
    const { reconcileTunnel } = await import("./lib/tunnel-service");
    void reconcileTunnel();

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

    // Keep one wildcard certificate current for the base every free subdomain is minted
    // under, so a new service is trusted HTTPS the moment it has a name instead of
    // waiting out an order of its own. A no-op on an instance with no Cloudflare token
    // or no deploy domain, which is why it needs no setting to turn it on.
    const { startWildcardCertRenewal } = await import("./lib/wildcard-cert-service");
    startWildcardCertRenewal();

    // Re-publish the certificates operators supplied for their own domains. Re-judged
    // rather than restored: the one thing that changes about a certificate with nobody
    // touching it is that it expires, and a lapsed one has to stop being served so the
    // managed certificate takes the name back.
    const { publishDomainCertificates } = await import("./lib/domain-cert-service");
    void publishDomainCertificates().catch((error) =>
        console.error("polaris: publishing domain certificates failed:", error)
    );

    // Move a GitHub token connected instance-wide onto the account of whoever
    // connected it, so it stops serving their private repositories to every other
    // account here. Best-effort and idempotent: a failure leaves the old row in
    // place and the next boot retries, rather than leaving deploys without a
    // clone credential.
    const { adoptInstanceGithubPat } = await import("./lib/connections/adopt-github-pat");
    void adoptInstanceGithubPat().catch((error) => console.error("polaris: GitHub token adoption failed:", error));

    // Vercel-style auto-deploy: poll connected GitHub repos and redeploy on a new
    // commit. Works without a public webhook (LAN installs can't receive one).
    const { startAutoDeployPoller } = await import("./lib/deploy/auto-deploy-poller");
    startAutoDeployPoller();

    // Keep a configured DuckDNS record pointed at the current public IP so a free
    // dynamic-DNS wildcard base stays reachable as the ISP IP changes.
    const { startDuckDnsSync } = await import("./lib/domain-service");
    startDuckDnsSync();

    // The same job for the operator's own domain. A DuckDNS name has been kept
    // pointed at this server's current address since the day it was added; the
    // domain they actually use was written once and never revisited, so an ISP
    // rotating the address took every one of them down silently.
    const { startZoneAddressSync } = await import("./lib/domain-address-sync");
    startZoneAddressSync();

    // Probe each deployed-app domain so a subdomain that resolves but does not
    // actually serve is flagged as down in the UI, instead of shown as a live link.
    const { startDomainHealthPoller } = await import("./lib/watch/domain-health-poller");
    startDomainHealthPoller();

    // Evaluate Watch alarms (CPU/memory spikes, service/domain down) against recent
    // metrics and health, firing notifications on state transitions.
    const { startAlarmEvaluator } = await import("./lib/watch/alarm-evaluator");
    startAlarmEvaluator();

    // Probe the addresses this deployment itself is listed as reachable at, so a
    // domain that stopped resolving is flagged rather than shown as a working link,
    // and a quick tunnel whose sidecar died is dropped instead of staying on the
    // sharing path.
    const { startAddressWatcher } = await import("./lib/address-health");
    startAddressWatcher();

    // Watch for a published Polaris build: tell the people who can install one, and
    // install it unattended when the deployment has been set to do that.
    const { startUpdateWatcher } = await import("./lib/update-watcher");
    startUpdateWatcher();

    // Keep each runner pool's ephemeral runners up: replace the ones that took a
    // job and exited, and remove the registrations left behind by a machine that
    // died mid-job, which GitHub would otherwise keep queueing work onto.
    const { startRunnerReconciler } = await import("./lib/runners/runner-reconciler");
    startRunnerReconciler();

    // Read the edge's access log on an interval and ban the addresses that have
    // earned it - the fail2ban half of the firewall, which a forwardAuth guard cannot
    // do itself because it is asked before the response (and its status) exists. Also
    // refreshes the Tor exit list and republishes the snapshot the guard enforces.
    const { startWafSentinel } = await import("./lib/waf-sentinel");
    startWafSentinel();

    // Fold the same access log into visits, so every deployed service has analytics
    // the moment it has a domain - no script tag, no redeploy, nothing for the app to
    // cooperate with. Also rolls each finished day into totals and drops the raw rows
    // past the retention window.
    const { startAnalyticsCollector } = await import("./lib/analytics-collector");
    startAnalyticsCollector();

    // Keep the schedules Polaris has been given: backup plans, task reminders, the
    // walk that lifts a game timeout when it runs out, and the sweeps that used to
    // happen only while somebody had the right screen open. These lived behind
    // /api/cron/* and so ran only on an instance where somebody had wired an
    // external scheduler to them - which meant a backup plan was, on most installs,
    // a promise nothing kept.
    const { startScheduledWork } = await import("./lib/cron/scheduler");
    startScheduledWork();

    // Listen to the cameras that decide for themselves that something moved. It is
    // the cheapest rung of the detection ladder by a wide margin - the camera is
    // doing that work whether or not Polaris exists - and it is one long-poll per
    // camera and no CPU. Does nothing at all on an instance with no cameras.
    const { startCameraWatcher } = await import("./lib/home/watcher");
    startCameraWatcher();

    // Re-establish messaging channels in the bridge after a bridge or web restart:
    // the bridge holds adapters in memory, so without this a channel stays
    // "connected" in the DB but dead at the bridge until manually reconnected.
    const { startChannelReconcile } = await import("./lib/messaging-service");
    startChannelReconcile();
}
