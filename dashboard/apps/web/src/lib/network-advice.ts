/**
 * What still has to be done outside Polaris for a domain to work, and telling the
 * operator about it.
 *
 * Correct DNS is only half of a public setup: on a home line the record points at
 * the router, and until 80 and 443 are forwarded nothing reaches this box. That
 * failure is invisible from the dashboard - the setup reports success and the site
 * answers with somebody else's error page - so it is diagnosed here and raised as a
 * notification rather than left for the operator to discover from outside.
 *
 * What has to be done depends on where the box lives, so the advice is keyed on the
 * detected environment: a router forward on a home line, a firewall rule on a VPS,
 * and on a carrier-NAT line no forward is possible at all and a tunnel is the only
 * way out.
 */

import { prisma } from "@polaris/db";
import type { ServerEnvironment } from "@polaris/core";
import { getHostLanIp } from "./host-address";
import { createNotification, type NotificationLevel } from "./notification-service";
import { getSetting, setSetting } from "./setting-store";

/** What answered on the public hostname, if anything. */
export type EdgeAnswer =
    /** Polaris itself: the request reached this box. */
    | "polaris"
    /** Something answered, but it was not Polaris - almost always the router. */
    | "other"
    /** Nothing answered at all. */
    | "silent";

export interface EdgeProbe {
    readonly answer: EdgeAnswer;
    /** How whatever answered named itself, when it did. Router firmware says so in
     *  the `Server` header, which is the fastest way for an operator to recognize
     *  their own box - Polaris sends none. */
    readonly server: string | null;
    /** The status it answered with, so the advice names the same error the operator
     *  is looking at in their browser. Null when nothing answered. */
    readonly status: number | null;
}

export interface RouterAdvice {
    /** Nothing left to do outside Polaris. */
    readonly ok: boolean;
    readonly level: NotificationLevel;
    readonly title: string;
    readonly detail: string;
    /** What the operator has to do, in the order they have to do it. */
    readonly steps: readonly string[];
    /** Distinguishes one situation from another, so the same advice is not raised
     *  twice while it goes on being true. */
    readonly key: string;
    /** Whether a port forward is what is missing, so the panel knows to walk the
     *  operator through their router. False where no forward can help (a firewall
     *  rule on a VPS, a carrier-NAT line). */
    readonly forward: boolean;
    /** How whatever answered named itself, carried through so the panel can start
     *  on that brand's instructions. Null when nothing answered. */
    readonly server: string | null;
    /** This server's LAN address - what the forward has to point at. */
    readonly lanIp: string | null;
}

/** The forward, worded once: both ports, and why :80 is not optional. */
const FORWARD_STEPS = [
    "Forward ports 80 and 443 on your router to this server.",
    "Port 80 is needed even for an HTTPS-only site: the certificate is issued over it."
];

/** Whether the environment is a home line, where the router is the operator's to
 *  configure. A datacenter box has no router in the way, only a firewall. */
function atHome(environment: ServerEnvironment): boolean {
    return environment === "home-nat" || environment === "home-cgnat";
}

/**
 * What is left to do for `hostname` to serve Polaris from the internet.
 *
 * Pure, and deliberately careful about what it claims: a probe leaves this box, and
 * a router that will not route its own public address back inward makes a working
 * domain look dead. So silence is reported as unconfirmed, while something *else*
 * answering is reported as certain - that one cannot be a measurement artifact.
 *
 * What it does not claim is why. A router answering its own public address from the
 * inside looks the same whether it publishes that page to the internet or is merely
 * bouncing the request back for want of a forward, and the second is far the commoner
 * - so the forward comes first and remote management is what to check if it persists.
 */
export function routerAdvice(
    environment: ServerEnvironment,
    hostname: string,
    probe: EdgeProbe,
    lanIp: string | null = null
): RouterAdvice {
    // Carried by every outcome: what answered, and what a forward would point at.
    const facts = { server: probe.server, lanIp };
    if (probe.answer === "polaris") {
        return {
            ok: true,
            level: "success",
            title: "Reachable from the internet",
            detail: `${hostname} reaches this server.`,
            steps: [],
            key: "ok",
            forward: false,
            ...facts
        };
    }

    if (probe.answer === "other") {
        // What answered, in the two terms the operator can match against their own
        // browser: the status they are staring at, and the name in the header.
        const status = probe.status ? ` It answers ${probe.status}` : " It answers";
        const named = probe.server ? `, and calls itself "${probe.server}".` : ".";
        // Carrier NAT first: it is a home line, but the forward the home branch asks
        // for cannot be made on it, so the shared `atHome` answer would walk the
        // operator through a router that has no inbound port to give them.
        if (environment === "home-cgnat") {
            return {
                ok: false,
                level: "danger",
                title: "Your router is answering instead of Polaris",
                detail:
                    `${hostname} reaches your line, but the reply comes from the router.${status}${named}` +
                    " Your provider shares one address between its customers, so no forward can bring the" +
                    " request any further than this.",
                steps: [
                    "Use a tunnel to publish the site, which needs no open port.",
                    "Or ask your provider for a public IP address, which some offer on request."
                ],
                key: "other:cgnat",
                forward: false,
                ...facts
            };
        }
        return atHome(environment)
            ? {
                  ok: false,
                  level: "danger",
                  title: "Your router is answering instead of Polaris",
                  detail:
                      `${hostname} reaches your line, but the reply comes from the router.${status}${named}` +
                      " Ports 80 and 443 are not reaching this server, so the router answers on its own behalf -" +
                      " which is the error you get in a browser.",
                  steps: [
                      ...FORWARD_STEPS,
                      "If the router still answers once the rules are saved, it is keeping 80 and 443 for its own" +
                          " admin page: turn off remote (WAN) management, or move it to another port."
                  ],
                  key: "other:home",
                  forward: true,
                  ...facts
              }
            : {
                  ok: false,
                  level: "danger",
                  title: "Something else is answering on this domain",
                  detail: `${hostname} reaches the server, but the reply does not come from Polaris.${status}${named}`,
                  steps: [
                      "Find what is holding ports 80 and 443 on this server and stop it, or move it to another port.",
                      "Check that the domain points at this server and not at another host."
                  ],
                  key: "other:datacenter",
                  forward: false,
                  ...facts
              };
    }

    if (environment === "home-cgnat") {
        return {
            ok: false,
            level: "danger",
            title: "Your line cannot receive incoming connections",
            detail:
                `Nothing answered on ${hostname}. Your provider puts you behind carrier-grade NAT,` +
                " so no port forward can work - the address is shared and it is not yours to open.",
            steps: [
                "Use a tunnel to publish the site, which needs no open port.",
                "Or ask your provider for a public IP address, which some offer on request."
            ],
            key: "silent:cgnat",
            forward: false,
            ...facts
        };
    }

    if (atHome(environment)) {
        return {
            ok: false,
            level: "warning",
            title: "Ports 80 and 443 may not reach this server",
            detail:
                `Nothing answered on ${hostname} from here. Plenty of routers will not route their own` +
                " public address back inward, so this is not proof on its own - check it from outside the network," +
                " on mobile data, to be sure.",
            steps: FORWARD_STEPS,
            key: "silent:home",
            forward: true,
            ...facts
        };
    }

    return {
        ok: false,
        level: "warning",
        title: "Ports 80 and 443 may not reach this server",
        detail: `Nothing answered on ${hostname} from here.`,
        steps: [
            "Allow inbound 80 and 443 in your provider's firewall or security group.",
            "Port 80 is needed even for an HTTPS-only site: the certificate is issued over it."
        ],
        key: "silent:datacenter",
        forward: false,
        ...facts
    };
}

/**
 * Ask the hostname who is serving it. `/api/health` is the marker: unauthenticated,
 * answered by Polaris and nothing else, so a reply that is not it is positive
 * evidence of something in the way rather than an inconclusive result.
 *
 * Plain HTTP on purpose, like the reachability probe: the certificate for the name
 * cannot exist until the name works.
 */
export async function probeEdge(hostname: string): Promise<EdgeProbe> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`http://${hostname}/api/health`, {
            cache: "no-store",
            redirect: "follow",
            signal: controller.signal
        });
        const server = response.headers.get("server");
        const status = response.status;
        if (response.ok) {
            const body = (await response.json().catch(() => null)) as { status?: string } | null;
            if (body?.status === "ok") return { answer: "polaris", server, status };
        }
        return { answer: "other", server, status };
    } catch {
        return { answer: "silent", server: null, status: null };
    } finally {
        clearTimeout(timer);
    }
}

/** Set once an advice has been raised, so it is not raised again while it holds. */
const KEY = "network.routerAdvice";

/**
 * Diagnose the hostname and tell the administrators when the answer changes.
 *
 * Only on a change: this runs on every DNS check, and a setup that stays broken for
 * a week must not fill the bell with the same notice. Recovery is announced too, so
 * an operator who fixed their router is told it worked without having to come back
 * and look.
 */
export async function reportRouterAdvice(
    environment: ServerEnvironment,
    hostname: string
): Promise<RouterAdvice> {
    const [probe, lanIp] = await Promise.all([probeEdge(hostname), getHostLanIp()]);
    const advice = routerAdvice(environment, hostname, probe, lanIp);
    const previous = await getSetting(KEY);
    if (previous === advice.key) return advice;
    await setSetting(KEY, advice.key);
    // Nothing to announce the first time the check runs and everything is already
    // working - there was no problem to report solved.
    if (advice.ok && previous === null) return advice;
    await notifyAdmins(advice);
    return advice;
}

/** Raise the advice for every administrator: this is the deployment's problem, not
 *  one user's, and whoever opens the dashboard first should see it. */
async function notifyAdmins(advice: RouterAdvice): Promise<void> {
    const admins = await prisma.user
        .findMany({ where: { isAdmin: true, bannedAt: null }, select: { id: true } })
        .catch(() => []);
    const body = advice.steps.length > 0 ? `${advice.detail}\n\n${advice.steps.join("\n")}` : advice.detail;
    await Promise.all(
        admins.map((admin) =>
            createNotification({
                userId: admin.id,
                type: "network.router",
                title: advice.title,
                body,
                level: advice.level,
                href: "/admin/domains",
                metadata: { key: advice.key }
            })
        )
    );
}
