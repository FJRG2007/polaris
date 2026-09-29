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

import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import { prisma, VISIBLE_USER } from "@polaris/db";
import { DEFAULT_LOCALE, type ServerEnvironment } from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";
import { readerWords } from "@/lib/i18n/reader-words";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { wordsFor } from "@/lib/notifications/notice-words";
import { getHostLanIp } from "./host-address";
import { notify } from "./notifications/dispatch";
import type { NotificationLevel } from "./notification-service";
import { getSetting, setSetting } from "./setting-store";

/** What answered on the public hostname, if anything. */
export type EdgeAnswer =
    /** Polaris itself: the request reached this box. */
    | "polaris"
    /** Something answered, but it was not Polaris - almost always the router. */
    | "other"
    /** Nothing answered at all. */
    | "silent";

/** Whether a browser would accept the certificate the name is served with. */
export type EdgeCertificate =
    /** Issued for this name by an authority browsers trust. */
    | "trusted"
    /** Served, but browsers will warn - Polaris's own certificate, or the wrong name. */
    | "untrusted"
    /** Nothing answered on 443, so there is nothing to judge. */
    | "unknown";

export interface EdgeProbe {
    readonly answer: EdgeAnswer;
    /** How whatever answered named itself, when it did. Router firmware says so in
     *  the `Server` header, which is the fastest way for an operator to recognize
     *  their own box - Polaris sends none. */
    readonly server: string | null;
    /** The status it answered with, so the advice names the same error the operator
     *  is looking at in their browser. Null when nothing answered. */
    readonly status: number | null;
    /** The state of HTTPS on the name, judged separately from reachability. */
    readonly certificate: EdgeCertificate;
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

type Words = NamespaceTranslator<"notices">;

/** The forward, worded once: both ports, and why :80 is not optional. */
function forwardSteps(t: Words): string[] {
    return [t("router.forward"), t("router.port80")];
}

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
    lanIp: string | null = null,
    /** The reader's words; the default language when there is no reader. */
    t: Words = translatorFor(DEFAULT_LOCALE, "notices")
): RouterAdvice {
    // Carried by every outcome: what answered, and what a forward would point at.
    const facts = { server: probe.server, lanIp };
    if (probe.answer === "polaris") {
        // The ports are open and Polaris is behind them. What can still be wrong is
        // the certificate, and that is worth saying rather than folding into a green
        // tick: the site works, and every visitor gets a browser warning.
        if (probe.certificate === "untrusted") {
            return {
                ok: false,
                level: "warning",
                title: t("router.certTitle"),
                detail: t("router.certDetail", { hostname }),
                steps: [t("router.certWait"), t("router.certContact")],
                key: "cert:untrusted",
                forward: false,
                ...facts
            };
        }
        return {
            ok: true,
            level: "success",
            title: t("router.okTitle"),
            detail: t("router.okDetail", { hostname }),
            steps: [],
            key: "ok",
            forward: false,
            ...facts
        };
    }

    if (probe.answer === "other") {
        // What answered, in the two terms the operator can match against their own
        // browser: the status they are staring at, and the name in the header.
        const answers = t("router.answers", {
            hasStatus: probe.status ? "yes" : "no",
            status: probe.status ?? "",
            hasServer: probe.server ? "yes" : "no",
            server: probe.server ?? ""
        });
        // Carrier NAT first: it is a home line, but the forward the home branch asks
        // for cannot be made on it, so the shared `atHome` answer would walk the
        // operator through a router that has no inbound port to give them.
        if (environment === "home-cgnat") {
            return {
                ok: false,
                level: "danger",
                title: t("router.routerTitle"),
                detail: t("router.routerCgnat", { hostname, answers }),
                steps: [t("router.useTunnel"), t("router.askProvider")],
                key: "other:cgnat",
                forward: false,
                ...facts
            };
        }
        return atHome(environment)
            ? {
                  ok: false,
                  level: "danger",
                  title: t("router.routerTitle"),
                  detail: t("router.routerHome", { hostname, answers }),
                  steps: [...forwardSteps(t), t("router.remoteManagement")],
                  key: "other:home",
                  forward: true,
                  ...facts
              }
            : {
                  ok: false,
                  level: "danger",
                  title: t("router.otherTitle"),
                  detail: t("router.otherDetail", { hostname, answers }),
                  steps: [t("router.findHolder"), t("router.checkPointing")],
                  key: "other:datacenter",
                  forward: false,
                  ...facts
              };
    }

    if (environment === "home-cgnat") {
        return {
            ok: false,
            level: "danger",
            title: t("router.cgnatTitle"),
            detail: t("router.cgnatDetail", { hostname }),
            steps: [t("router.useTunnel"), t("router.askProvider")],
            key: "silent:cgnat",
            forward: false,
            ...facts
        };
    }

    if (atHome(environment)) {
        return {
            ok: false,
            level: "warning",
            title: t("router.silentTitle"),
            detail: t("router.silentHome", { hostname }),
            steps: forwardSteps(t),
            key: "silent:home",
            forward: true,
            ...facts
        };
    }

    return {
        ok: false,
        level: "warning",
        title: t("router.silentTitle"),
        detail: t("router.silentDatacenter", { hostname }),
        steps: [t("router.allowInbound"), t("router.port80")],
        key: "silent:datacenter",
        forward: false,
        ...facts
    };
}

/** How long a single probe may take. Both run in parallel, so this is the total. */
const PROBE_TIMEOUT_MS = 5000;

/** Whether a body is Polaris's health answer, which nothing else serves. */
function isHealth(text: string): boolean {
    try {
        return (JSON.parse(text) as { status?: string }).status === "ok";
    } catch {
        return false;
    }
}

interface PortProbe {
    readonly polaris: boolean;
    readonly answered: boolean;
    readonly status: number | null;
    readonly server: string | null;
}

/**
 * Port 80, without following the redirect.
 *
 * Following it was what made a working setup look dead: the edge sends :80 to
 * https, the redirect was followed, and the certificate check failed - which throws
 * exactly like nothing answering. So the redirect is inspected instead of taken. It
 * is also evidence in itself: an edge that redirects THIS name to HTTPS on the same
 * name is serving it, which a router bouncing the request back is not.
 */
async function probeHttp(hostname: string): Promise<PortProbe & { redirectsToTls: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const response = await fetch(`http://${hostname}/api/health`, {
            cache: "no-store",
            redirect: "manual",
            signal: controller.signal
        });
        const server = response.headers.get("server");
        const status = response.status;
        if (response.ok && isHealth(await response.text().catch(() => ""))) {
            return { polaris: true, answered: true, status, server, redirectsToTls: false };
        }
        const location = response.headers.get("location") ?? "";
        let redirectsToTls = false;
        try {
            const target = new URL(location, `http://${hostname}`);
            redirectsToTls = target.protocol === "https:" && target.hostname === hostname;
        } catch {
            // A Location this malformed is not evidence of anything.
        }
        return { polaris: false, answered: true, status, server, redirectsToTls };
    } catch {
        return { polaris: false, answered: false, status: null, server: null, redirectsToTls: false };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Port 443, without requiring the certificate to be valid.
 *
 * An untrusted certificate still proves the port reaches Polaris, and that is the
 * question being asked here - whether a browser would accept it is reported on its
 * own, because the two have different answers and different fixes. Node's own client
 * rather than fetch: it is the one that will report both.
 */
function probeHttps(hostname: string): Promise<PortProbe & { trusted: boolean }> {
    return new Promise((resolve) => {
        const failed = { polaris: false, answered: false, status: null, server: null, trusted: false };
        const request = httpsRequest(
            {
                host: hostname,
                port: 443,
                path: "/api/health",
                method: "GET",
                servername: hostname,
                rejectUnauthorized: false,
                timeout: PROBE_TIMEOUT_MS
            },
            (response) => {
                // Read here, not on `end`: the socket is handed back to the pool when
                // the response completes, and `response.socket` is null by then.
                const trusted = (response.socket as TLSSocket | null)?.authorized === true;
                const status = response.statusCode ?? null;
                const server = (response.headers.server as string | undefined) ?? null;
                let body = "";
                response.setEncoding("utf8");
                // Bounded: a health answer is a few dozen bytes, and whatever else is
                // on the port must not be read into memory unchecked.
                response.on("data", (chunk: string) => {
                    if (body.length < 4096) body += chunk;
                });
                response.on("end", () =>
                    resolve({ polaris: isHealth(body), answered: true, status, server, trusted })
                );
                response.on("error", () => resolve(failed));
            }
        );
        request.on("timeout", () => request.destroy());
        request.on("error", () => resolve(failed));
        request.end();
    });
}

/**
 * Ask the hostname who is serving it. `/api/health` is the marker: unauthenticated,
 * answered by Polaris and nothing else, so a reply that is not it is positive
 * evidence of something in the way rather than an inconclusive result.
 *
 * Both ports are asked, because they fail apart: 80 open and 443 shut is a
 * half-finished forward, and the certificate lives on 443 while the challenge that
 * issues it arrives on 80.
 */
export async function probeEdge(hostname: string): Promise<EdgeProbe> {
    const [http, https] = await Promise.all([probeHttp(hostname), probeHttps(hostname)]);
    const certificate: EdgeCertificate = !https.answered ? "unknown" : https.trusted ? "trusted" : "untrusted";

    if (https.polaris || http.polaris) {
        return {
            answer: "polaris",
            server: null,
            status: https.polaris ? https.status : http.status,
            certificate
        };
    }
    // The edge sending this name to HTTPS is Polaris answering on 80, even when 443
    // could not be read - a wrong certificate, or a rule that opened one port only.
    if (http.redirectsToTls) {
        return { answer: "polaris", server: http.server, status: http.status, certificate };
    }
    if (http.answered || https.answered) {
        const source = http.answered ? http : https;
        return { answer: "other", server: source.server, status: source.status, certificate };
    }
    return { answer: "silent", server: null, status: null, certificate };
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
    const advice = routerAdvice(environment, hostname, probe, lanIp, await readerWords("notices"));
    const previous = await getSetting(KEY);
    if (previous === advice.key) return advice;
    await setSetting(KEY, advice.key);
    // Nothing to announce the first time the check runs and everything is already
    // working - there was no problem to report solved.
    if (advice.ok && previous === null) return advice;
    await notifyAdmins((t) => routerAdvice(environment, hostname, probe, lanIp, t));
    return advice;
}

/** Raise the advice for every administrator: this is the deployment's problem, not
 *  one user's, and whoever opens the dashboard first should see it. */
async function notifyAdmins(adviceIn: (t: Words) => RouterAdvice): Promise<void> {
    const admins = await prisma.user
        .findMany({ where: { isAdmin: true, ...VISIBLE_USER }, select: { id: true } })
        .catch(() => []);
    await Promise.all(
        admins.map(async (admin) => {
            // Each administrator reads it in their own language.
            const advice = adviceIn(await wordsFor(admin.id, "notices"));
            const body = advice.steps.length > 0 ? `${advice.detail}\n\n${advice.steps.join("\n")}` : advice.detail;
            return notify({
                userId: admin.id,
                event: "network.router",
                title: advice.title,
                body,
                level: advice.level,
                audience: "admins",
                actionRequired: !advice.ok,
                href: "/admin/domains",
                metadata: { key: advice.key }
            });
        })
    );
}
