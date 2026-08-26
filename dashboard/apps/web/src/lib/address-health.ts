/**
 * Whether the addresses this deployment lists are actually answering.
 *
 * Settings lists every way in - the install URL, the configured domains, a tunnel -
 * and until now nothing ever checked one again after it was added. A domain whose
 * DNS moved, or a quick tunnel whose sidecar died, stayed on the list as a working
 * link forever. The tunnel is the worse of the two: its URL is cached in a setting
 * and `sharingBaseUrl()` prefers it, so a dead one is not just a stale row on a
 * page - it is what every share link handed out afterwards points at.
 *
 * So each address is probed on a loop, the result is kept per host, and a change is
 * announced once. What happens to a dead address depends on what it is:
 *
 * - A domain an operator configured is never removed here. It is theirs, the outage
 *   is usually somewhere else (DNS, the ISP, the edge), and deleting it would take
 *   the routing with it. It is marked unreachable and reported.
 * - A quick tunnel URL is disposable by definition - it is minted per cloudflared
 *   process and can never come back - so when the sidecar behind it is gone the URL
 *   is forgotten, which also takes it off the sharing path.
 *
 * Only addresses on a public hostname are probed. The LAN names (`polaris.local`,
 * an IP) resolve on the operator's machine and not inside this container, so
 * probing them would report the deployment's main address as down while it works.
 */

import { prisma } from "@polaris/db";
import type { Permission } from "@polaris/core";
import { publicHostname, syncDashboardRoute } from "@/lib/domain-edge";
import { checkDomain } from "@/lib/watch/health-probe";
import { removeDashboardDomain } from "@/lib/domain-service";
import { notifyOperators } from "@/lib/notifications/operators";
import { reachableAddresses, type DeploymentAddress } from "@/lib/deployment-addresses";
import { getPolarisTunnelStatus, stopPolarisTunnel } from "@/lib/polaris-tunnel-service";

/** Who hears about an address going down - the people who can fix one. */
const ADDRESS_PERMISSION: Permission = "system.manage";

/** One row per host, so a change of state is a conditional write only one container
 *  can win, exactly like the update watcher's claims. */
const KEY_PREFIX = "address.health.";

/** Slower than the deployed-app probe: these are a handful of addresses, and an
 *  operator does not need to hear about a blip on their own dashboard's domain. */
const INTERVAL_MS = Number(process.env.POLARIS_ADDRESS_WATCH_MS) || 10 * 60_000;
/** Let the deployment finish coming up before deciding it is unreachable. */
const FIRST_PASS_MS = 60_000;
/** A second opinion before calling an address down, since one alert is worth more
 *  than two and a single timeout is not an outage. */
const RETRY_MS = 3000;

/** How much of a failure reason is kept. It goes in a settings value, one line. */
const DETAIL_LIMIT = 120;

let started = false;

export type AddressState = "up" | "down" | "unknown";

export interface AddressHealth {
    readonly state: AddressState;
    /** When it was last probed, or null while it never has been. */
    readonly checkedAt: string | null;
    /** Why it is down, in the words the probe used. */
    readonly detail: string | null;
}

export interface CheckedAddress extends DeploymentAddress {
    readonly health: AddressHealth;
}

const UNKNOWN: AddressHealth = { state: "unknown", checkedAt: null, detail: null };

function keyFor(host: string): string {
    return `${KEY_PREFIX}${host}`;
}

/** An address this container can meaningfully dial: a public name, not a LAN one. */
function checkable(address: DeploymentAddress): boolean {
    return publicHostname(address.host) !== null;
}

/** One line, short enough to store beside the state and read in an alert. */
function tidy(detail: string | null): string | null {
    if (!detail) return null;
    const line = detail.replace(/\s+/g, " ").trim();
    return line ? line.slice(0, DETAIL_LIMIT) : null;
}

/** `state ISO detail...`, the shape the conditional claim matches on its prefix. */
function encode(state: AddressState, detail: string | null): string {
    return `${state} ${new Date().toISOString()}${detail ? ` ${detail}` : ""}`;
}

function decode(value: string | null | undefined): AddressHealth {
    if (!value) return UNKNOWN;
    const [state, checkedAt, ...rest] = value.split(" ");
    return {
        state: state === "up" || state === "down" ? state : "unknown",
        checkedAt: checkedAt ?? null,
        detail: rest.join(" ") || null
    };
}

/** The stored health of every address that has been probed, by host. */
async function storedHealth(): Promise<Map<string, AddressHealth>> {
    const rows = await prisma.setting.findMany({
        where: { key: { startsWith: KEY_PREFIX } },
        select: { key: true, value: true }
    });
    return new Map(rows.map((row) => [row.key.slice(KEY_PREFIX.length), decode(row.value)]));
}

/**
 * The addresses with what is known about each. Reads the last sweep's result rather
 * than probing: this is on the settings page, and a page load must not wait on a
 * name that is down precisely because it takes the full timeout to find out.
 */
export async function checkedAddresses(): Promise<CheckedAddress[]> {
    const [addresses, health] = await Promise.all([
        reachableAddresses(),
        storedHealth().catch(() => new Map<string, AddressHealth>())
    ]);
    return addresses.map((address) => ({
        ...address,
        health: health.get(address.host) ?? UNKNOWN
    }));
}

/** Why an address could not be taken off the list, when it could not. */
export type AddressRemoval = "removed" | "unknown" | "built-in" | "managed";

/**
 * Take an address off this deployment's list, on the operator's word rather than a
 * probe's. The list is assembled from four places and says nothing about which, so
 * the lookup happens here:
 *
 * - a tunnel is torn down, which is what makes the URL stop being handed out (a
 *   quick tunnel's URL is minted per run, so there is nothing to keep anyway);
 * - a configured domain is cleared from whichever setting holds it;
 * - the install URL and the LAN name come from the deployment itself, and the zone
 *   host from the guided setup, so neither is a list entry to delete.
 */
export async function removeAddress(host: string): Promise<AddressRemoval> {
    const address = (await reachableAddresses()).find(
        (entry) => entry.host === host.trim().toLowerCase()
    );
    if (!address) return "unknown";
    if (address.kind === "app" || address.kind === "local") return "built-in";
    if (address.kind === "tunnel") {
        await stopPolarisTunnel();
        await prisma.setting.deleteMany({ where: { key: keyFor(address.host) } });
        return "removed";
    }
    if (!(await removeDashboardDomain(address.host))) return "managed";
    await prisma.setting.deleteMany({ where: { key: keyFor(address.host) } });
    return "removed";
}

/**
 * Probe one address, twice before giving up on it. A redirect or an auth challenge
 * counts as answering - what is being asked is whether anything is listening on that
 * name, not whether it hands this container a page.
 */
async function probe(
    address: DeploymentAddress
): Promise<{ state: "up" | "down"; detail: string | null; notRouted: boolean }> {
    const target = { hostname: address.host, https: address.url.startsWith("https:") };
    const first = await checkDomain(target);
    if (first.status === "up") return { state: "up", detail: null, notRouted: false };
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    const second = await checkDomain(target);
    if (second.status === "up") return { state: "up", detail: null, notRouted: false };
    return { state: "down", detail: tidy(second.detail), notRouted: second.notRouted === true };
}

/** What a sweep found for one address, relative to what was already known. */
type Claim = "first" | "changed" | "same";

/**
 * Record this pass's result and say whether it is news.
 *
 * Two web containers serve at once during a rollover and both sweep, so the state
 * lives in the row rather than in a process: the conditional write is a decision
 * only one of them can win, and the loser just refreshes the timestamp. Without it
 * every outage is reported twice.
 */
async function record(host: string, state: AddressState, value: string): Promise<Claim> {
    const key = keyFor(host);
    try {
        await prisma.setting.create({ data: { key, value, scope: "global" } });
        return "first";
    } catch {
        const taken = await prisma.setting.updateMany({
            where: { key, NOT: { value: { startsWith: `${state} ` } } },
            data: { value }
        });
        if (taken.count === 1) return "changed";
        await prisma.setting.updateMany({ where: { key }, data: { value } });
        return "same";
    }
}

/** Forget what was known about hosts that are no longer listed, so a removed domain
 *  does not leave a row that outlives it. */
async function forgetMissing(hosts: readonly string[]): Promise<void> {
    await prisma.setting.deleteMany({
        where: {
            key: { startsWith: KEY_PREFIX },
            ...(hosts.length > 0 ? { NOT: { key: { in: hosts.map(keyFor) } } } : {})
        }
    });
}

/**
 * Drop a tunnel URL whose tunnel is gone.
 *
 * Only when the sidecar itself is not running: a URL that stops answering while
 * cloudflared is up is an outage somewhere in between, and tearing the tunnel down
 * over it would turn a blip into the thing it was reporting. Returns whether the
 * address was actually dropped.
 */
async function dropDeadTunnel(host: string): Promise<boolean> {
    const status = await getPolarisTunnelStatus().catch(() => ({ running: true, url: null }));
    if (status.running) return false;
    await stopPolarisTunnel();
    await prisma.setting.deleteMany({ where: { key: keyFor(host) } });
    return true;
}

/** Probe one address and say what changed, once, whichever container gets there first. */
async function sweepAddress(address: DeploymentAddress): Promise<void> {
    const { state, detail, notRouted } = await probe(address);
    const claim = await record(address.host, state, encode(state, detail));
    // The edge answered that it routes this name nowhere. For a dashboard address that
    // is a file this process writes, so write it again: no screen offers to, and an
    // operator reading the alert has no terminal to do it from. Best-effort, and the
    // next sweep is what says whether it worked.
    if (notRouted) {
        await syncDashboardRoute().catch((error: unknown) =>
            console.error(
                "polaris: republishing the dashboard route after an unrouted address failed:",
                error
            )
        );
    }
    if (claim === "same") return;

    if (state === "up") {
        // A first sighting that works is not news; a recovery is.
        if (claim === "changed") {
            await notifyOperators({
                permission: ADDRESS_PERMISSION,
                event: "network.address",
                title: `${address.host} is answering again`,
                body: `${address.url} is reachable again.`,
                href: "/admin/settings",
                level: "success"
            });
        }
        return;
    }

    if (address.kind === "tunnel" && (await dropDeadTunnel(address.host))) {
        await notifyOperators({
            permission: ADDRESS_PERMISSION,
            event: "network.address",
            title: "The tunnel address is gone",
            body: `${address.url} stopped answering and its tunnel is no longer running, so it has been dropped from this deployment's addresses. Share links move to the next address. Settings can raise a new tunnel.`,
            href: "/admin/settings"
        });
        return;
    }

    await notifyOperators({
        permission: ADDRESS_PERMISSION,
        event: "network.address",
        title: `${address.host} is not answering`,
        body: `Nothing answered at ${address.url}${detail ? ` (${detail})` : ""}. It is still listed in Settings, marked unreachable.`,
        href: "/admin/settings",
        actionRequired: true
    });
}

/**
 * One pass over every address. Sequential on purpose: there are a handful of them,
 * a down one spends its timeouts, and nothing here is worth opening several
 * connections out of the box at once for.
 */
export async function sweepAddresses(): Promise<void> {
    const addresses = (await reachableAddresses()).filter(checkable);
    await forgetMissing(addresses.map((address) => address.host));
    for (const address of addresses) {
        await sweepAddress(address).catch((error) =>
            console.error(`polaris: checking ${address.host} failed:`, error)
        );
    }
}

export function startAddressWatcher(): void {
    if (started) return;
    started = true;
    const tick = (): void => {
        void sweepAddresses().catch((error) =>
            console.error("polaris: address health sweep failed:", error)
        );
    };
    setTimeout(tick, FIRST_PASS_MS).unref();
    setInterval(tick, INTERVAL_MS).unref();
}
