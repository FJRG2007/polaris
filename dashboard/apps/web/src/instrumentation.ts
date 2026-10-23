/**
 * Server instrumentation. Installs last-resort guards so a faulty connector (an
 * SMB client that throws an async socket/crypto error, say) can never take the
 * whole dashboard down with an uncaught exception - the failing request errors,
 * the server stays up. Node runtime only; the edge runtime has no process events.
 */

export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    // First, before anything can answer a request: an installed app's server
    // action is loaded on its own, without the page or route that would
    // otherwise have provided the dashboard's services to it.
    await import("./lib/app-host/server");

    process.on("uncaughtException", (error) => {
        console.error("polaris: uncaught exception (server kept alive):", error);
    });
    process.on("unhandledRejection", (reason) => {
        console.error("polaris: unhandled rejection (server kept alive):", reason);
    });

    // And write them down. The console line is what somebody reading container
    // logs looks for; this is what somebody who was not watching finds
    // afterwards, on the same screen a deployed application reports to.
    const { watchProcessFailures, watchLoggedFailures } = await import("./lib/telemetry/capture");
    watchProcessFailures();
    // And the failures Polaris HANDLED, which is nearly all of them. A process
    // falling over is the rare case; what actually happens is caught, logged,
    // and carried on from - into a container log nobody running this is ever
    // going to open, while the Telemetry screen promised to show it.
    watchLoggedFailures();

    // Detect the edition and keep it live: probe polaris-hostd on startup and on
    // an interval, folding its capability report into the shared snapshot that
    // getCapabilities() serves. Without this the dashboard is stuck reporting the
    // limited edition even when the daemon is running.
    const { startCapabilityRefresh } = await import("@polaris/hostd-client");
    startCapabilityRefresh();

    // Sample consumption of deployed apps and Drive devices on an interval, so the
    // dashboard can chart history and not just the live value. Self-guarding: a bad
    // tick only logs. Skipped during the build (register runs at server start).
    //
    // This and every other loop below that acts on its own - starting deploys,
    // restarting containers, recreating tunnels, ordering certificates, counting
    // visits - waits for the dashboard this one replaced to be retired. An update
    // starts this process while the previous one still serves and still runs all
    // of them; started here as well, each would do its work twice for the length of
    // the rollover: two deploys of one commit, two restarts of the call server, a
    // tunnel recreated under a name the other is serving. The previous process keeps
    // them running until the moment it stops, so nothing is missed by waiting.
    const { afterPredecessor, whenAlone } = await import("./lib/deploy/dashboard-peers");
    const { startMetricsCollector } = await import("./lib/metrics-collector-service");
    void afterPredecessor().then(startMetricsCollector);

    // Watch every UPS: its history, its alerts and the shutdown of the machines
    // it protects. After the predecessor, like the collector, so an update's
    // overlap never sends one shutdown twice.
    const { startUpsWatch } = await import("./lib/ups/ups-service");
    void afterPredecessor().then(startUpsWatch);

    // Write the Traefik dynamic routes for deployed-app domains on startup, so the
    // edge self-heals after a restart or a fresh dynamic volume. Best-effort.
    const { syncAppRoutes, reconcileNasMounts, recoverAbandonedDeployments } =
        await import("./lib/deploy-service");
    const { guardVacantReachable } = await import("./lib/deploy/router");
    //
    // Published at once - the routes are read from the database, so both dashboards
    // write the same file and an unchanged one is not rewritten - but the releases a
    // change-over kept running are only retired once this is the only dashboard: a
    // promotion the previous one is in the middle of is draining them itself.
    void syncAppRoutes({ retireHeld: false })
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
                void syncAppRoutes({ retireHeld: false }).catch((error) =>
                    console.error("polaris: the route resync for the edge guard failed:", error)
                );
            }, 30_000).unref();
        })
        .catch((error) => console.error("polaris: initial route sync failed:", error));
    void afterPredecessor()
        .then(() => syncAppRoutes())
        .catch((error) =>
            console.error("polaris: the route sync after the rollover failed:", error)
        );

    // Close out deploys this process cannot possibly be running: the deploy queue is
    // in memory, so anything left mid-flight by the previous process is abandoned, and
    // a row that still reads DEPLOYING is one an operator waits on instead of retrying.
    //
    // Only once that previous process is gone. An update starts this one while the
    // old dashboard is still serving, and a deploy it is running then is live, not
    // abandoned: closing it out here failed it on screen and on GitHub while it went
    // on to finish (see lib/deploy/dashboard-peers.ts).
    //
    // Then close the host ports the edge should be the only way past: a service with
    // a domain answered on its machine's IP and a port as well, with its firewall and
    // login nowhere in the way. Each is moved through the change-over, so nothing
    // goes down - one that cannot change over waits for its next deploy - and only after the close-out, which would otherwise fail these very
    // deploys as abandoned (see lib/deploy/direct-port.ts).
    void whenAlone(async () => {
        await recoverAbandonedDeployments().catch((error) =>
            console.error("polaris: could not close out interrupted deploys:", error)
        );
        const { closeDirectPorts } = await import("./lib/deploy/direct-port-close");
        const { closed, deferred } = await closeDirectPorts({}, { mode: "boot", actorId: null });
        if (closed.length > 0 || deferred.length > 0) {
            console.info(
                `polaris: closing the direct host port of ${closed.length} service(s); ${deferred.length} close on their next deploy`
            );
        }
    }).catch((error) => console.error("polaris: could not close direct host ports:", error));

    // The key the media server signs with, minted here rather than by the
    // installer: .env is only ever written by a script and an installed Polaris
    // is only ever updated from a button, so a key that had to appear there is a
    // key no existing deployment has and no operator can give it one. The
    // container refuses to start until this lands, and restarts until it does -
    // which is why this is awaited rather than fired off with everything else.
    // What it writes is decided inside: an install that already had a pair keeps
    // it, so an update does not change the key of a deployment whose calls work.
    const { ensureCallKey } = await import("./lib/chat/call-keys");
    await ensureCallKey().catch((error) =>
        console.error("polaris: could not prepare the call server key:", error)
    );

    // The certificate contact chosen in Domains, put back where the edge reads it
    // when it starts, for a volume that was recreated or restored since.
    const { syncAcmeEmailFile } = await import("./lib/tls/acme-edge");
    void syncAcmeEmailFile().catch((error) =>
        console.error("polaris: could not publish the certificate contact:", error)
    );

    // Same for the dashboard's own public hostnames, which the compose labels cannot
    // carry: they are fixed at `up` time, so a domain configured afterwards would only
    // reach the edge again the next time it was saved.
    //
    // The call server's path goes out with them, from inside that same function:
    // it rides these hostnames and carries their allowlist, so the two must not
    // be written by two callers racing on one directory Traefik watches.
    //
    // Retried until it lands, which neither of the others needs: both files are
    // read from the database, and the one carrying the call route is the only way
    // a browser can reach the media server at all - so a database that is still
    // starting here means every call fails at the first WebSocket until somebody
    // happens to save a domain, and on a LAN-only install nobody ever does.
    const { syncDashboardRoute } = await import("./lib/domain-edge");
    void publishEdgeRoutes(syncDashboardRoute);

    // Migrate any quick tunnel still forwarding straight to an app's port onto the edge,
    // so its traffic is logged (and future restarts leave an edge tunnel untouched).
    const { reconcileQuickTunnels } = await import("./lib/deploy/quick-tunnel-service");
    void afterPredecessor()
        .then(reconcileQuickTunnels)
        .catch((error) => console.error("polaris: quick-tunnel reconcile failed:", error));

    // And the server's own tunnel, for the same reason: a connector raised against an
    // origin that has since changed keeps running and forwards into nothing. Only one
    // whose origin no longer matches is recreated, so a healthy tunnel keeps its URL.
    const { reconcileTunnel } = await import("./lib/tunnel-service");
    void afterPredecessor().then(reconcileTunnel);

    // Re-establish NAS volume mounts a host reboot dropped, restarting any app whose
    // mount had to be re-created - so a NAS-backed volume survives reboots like a real
    // docker volume. Best-effort; a routine restart keeps live mounts and is a no-op.
    void afterPredecessor()
        .then(reconcileNasMounts)
        .catch((error) => console.error("polaris: initial NAS mount reconcile failed:", error));

    // And keep them attached afterwards: a NAS that drops or changes address
    // takes a running service's volumes with it, and the service keeps running
    // with every file answering "Host is down". The watcher mends what it can and
    // tells the service's owner what it cannot.
    const { startVolumeWatcher } = await import("./lib/deploy/volume-watch");
    void afterPredecessor().then(startVolumeWatcher);

    // Carry on creating the data engines a provider was still creating when the
    // last process stopped, and give up with a reason on the ones that took too long.
    const { startCloudProvisionWatch } = await import("./lib/data-cloud/service");
    void afterPredecessor().then(startCloudProvisionWatch);

    // Who this Polaris is, for clients that fall back to its LAN address when the
    // public one stops answering. Made here when an install has none, so nothing
    // has to be configured for it.
    const { ensureInstanceIdentity } = await import("./lib/instance-identity");
    void ensureInstanceIdentity().catch((error) => console.error("polaris: instance identity setup failed:", error));

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
    void afterPredecessor().then(startWildcardCertRenewal);

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
    void adoptInstanceGithubPat().catch((error) =>
        console.error("polaris: GitHub token adoption failed:", error)
    );

    // Vercel-style auto-deploy: poll connected GitHub repos and redeploy on a new
    // commit. Works without a public webhook (LAN installs can't receive one).
    const { startAutoDeployPoller } = await import("./lib/deploy/auto-deploy-poller");
    void afterPredecessor().then(startAutoDeployPoller);

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

    // Carry Watch alarms into Automations, once each: an enabled alarm on a
    // reading becomes a published automation and Watch stops evaluating it. After
    // the predecessor so the two dashboards of an update do not both try; the
    // unique legacyRef covers them if they do.
    const { carryWatchAlarms } = await import("./lib/watch/alarm-carry");
    void afterPredecessor()
        .then(carryWatchAlarms)
        .catch((error: unknown) =>
            console.error("polaris: Watch alarms could not be carried to Automations:", error)
        );

    // Domain health and Watch alarms used to start here, as two timers of their
    // own. They are scheduled jobs now - `domain-health` and `alarms` in
    // `lib/cron/jobs.ts` - because a timer takes no lease, and during an update
    // two web containers serve at once: both evaluated every alarm, and both
    // announced the same threshold crossing to the same person.

    // Probe the addresses this deployment itself is listed as reachable at, so a
    // domain that stopped resolving is flagged rather than shown as a working link,
    // and a quick tunnel whose sidecar died is dropped instead of staying on the
    // sharing path.
    const { startAddressWatcher } = await import("./lib/address-health");
    void afterPredecessor().then(startAddressWatcher);

    // Watch for a published Polaris build: tell the people who can install one, and
    // install it unattended when the deployment has been set to do that.
    const { startUpdateWatcher } = await import("./lib/update-watcher");
    startUpdateWatcher();

    // Move the open agent rollout along wave by wave, record each server's
    // heartbeat, and deliver the commands waiting for servers that answer again.
    const { startRolloutLoop } = await import("./lib/agent-rollouts/service");
    startRolloutLoop();

    // Keep each runner pool's ephemeral runners up: replace the ones that took a
    // job and exited, and remove the registrations left behind by a machine that
    // died mid-job, which GitHub would otherwise keep queueing work onto.
    const { startRunnerReconciler } = await import("./lib/runners/runner-reconciler");
    void afterPredecessor().then(startRunnerReconciler);

    // Read the edge's access log on an interval and ban the addresses that have
    // earned it - the fail2ban half of the firewall, which a forwardAuth guard cannot
    // do itself because it is asked before the response (and its status) exists. Also
    // refreshes the Tor exit list and republishes the snapshot the guard enforces.
    const { startWafSentinel } = await import("./lib/waf-sentinel");
    void afterPredecessor().then(startWafSentinel);

    // Fold the same access log into visits, so every deployed service has analytics
    // the moment it has a domain - no script tag, no redeploy, nothing for the app to
    // cooperate with. Also rolls each finished day into totals and drops the raw rows
    // past the retention window.
    const { startAnalyticsCollector } = await import("./lib/analytics-collector");
    void afterPredecessor().then(startAnalyticsCollector);

    // Keep the schedules Polaris has been given: backup plans, task reminders, the
    // walk that lifts a game timeout when it runs out, and the sweeps that used to
    // happen only while somebody had the right screen open. These lived behind
    // /api/cron/* and so ran only on an instance where somebody had wired an
    // external scheduler to them - which meant a backup plan was, on most installs,
    // a promise nothing kept.
    //
    // After the installed apps' code is here: their jobs are part of that list.
    // An update lands on this line with the apps' previous build on the volume,
    // and this is where each is replaced with the one built with this image.
    const { prepareAppBundles } = await import("./lib/app-bundles/lifecycle");
    await prepareAppBundles().catch((error: unknown) =>
        console.error("polaris: the installed apps could not be prepared:", error)
    );
    const { startScheduledWork } = await import("./lib/cron/scheduler");
    startScheduledWork();

    // What the installed apps start with the server: Places brings its own
    // containers to this build and starts listening to its cameras.
    const { bootApps } = await import("./lib/app-extensions/registry");
    void afterPredecessor().then(bootApps);

    // Re-establish messaging channels in the bridge after a bridge or web restart:
    // the bridge holds adapters in memory, so without this a channel stays
    // "connected" in the DB but dead at the bridge until manually reconnected.
    const { startChannelReconcile } = await import("./lib/messaging-service");
    startChannelReconcile();

    // Watch the address this line hands out to callers. A media server asks for
    // it once, as it starts, and hands out that answer for the life of the
    // container - so a connection whose address is not permanent silently starts
    // sending everybody's sound to somebody else's address, while every screen
    // in the product says the call is healthy. Restarting it is the whole
    // repair, so Polaris does that itself and tells an administrator afterwards.
    const { startCallAddressWatch } = await import("./lib/chat/call-address-watch");
    void afterPredecessor().then(startCallAddressWatch);
}

/** How long each further attempt waits, in order. Backed off rather than
 *  repeated: what it is waiting on is a database still coming up, which is
 *  seconds on an ordinary boot and minutes on the one where migrations are
 *  running on a slow disk. Just over eight minutes in all. */
const ROUTE_RETRY_MS = [30_000, 60_000, 120_000, 300_000];

/**
 * Publish the dashboard's route, and the call server's with it, until one
 * attempt reports the file written.
 *
 * Reported rather than fired and forgotten, because there is no screen that can
 * ask for this and no button that repairs it: an edge left with no call route
 * serves every page and no call, and the only other thing that rewrites the file
 * is saving a domain or a firewall rule - which a deployment that only ever
 * calls between rooms in the house never does. Giving up is logged, so a support
 * question has an answer.
 *
 * Takes the sync as an argument, so the one thing worth asserting here - that a
 * boot which cannot reach the database yet ends with a route rather than with
 * silence - can be asserted without starting a server.
 */
export async function publishEdgeRoutes(sync: () => Promise<boolean>): Promise<void> {
    for (const wait of [0, ...ROUTE_RETRY_MS]) {
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait).unref());
        const written = await sync().catch((error) => {
            console.error("polaris: publishing the edge routes failed:", error);
            return false;
        });
        if (written) return;
    }
    console.error(
        "polaris: gave up publishing the call server route - calls have no way through the edge until a domain or a firewall rule is saved, or this deployment restarts"
    );
}
