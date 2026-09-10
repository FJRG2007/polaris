/**
 * Traefik routing config as container labels. Traefik's docker provider discovers
 * a deployed service by these labels on the shared proxy network, so routing is
 * decoupled from any central table and works identically for compose and swarm.
 * Pure: given a service name, network, and its domains, produce the label map (and
 * a stable hash of it for idempotency/drift detection).
 */

import { createHash } from "node:crypto";
import { encodeGuardRule } from "@polaris/core/waf";
import type { AppEdgeConfig, WafCustomRule, WafPrincipalGrant } from "@polaris/core";
import { isWildcardHostname, normalizeDeployHostname, securityHeaderMap } from "@polaris/core";

export type CertResolver = "le" | "internal" | "none";

export interface TraefikDomain {
    readonly hostname: string;
    readonly targetPort: number;
    readonly pathPrefix?: string;
    readonly certResolver: CertResolver;
}

/** Resolved WAF decision for a service, materialized into edge labels. Mirrors
 *  `ResolvedWaf` but kept structural so this pure builder needs no schema import. */
export interface TraefikWaf {
    /** One IP allowlist per scope; each becomes a chained `ipAllowList` middleware. */
    readonly allowLists?: readonly (readonly string[])[];
    readonly deny?: readonly string[];
    /** Managed rule-pack ids, expanded by the guard rather than sent expanded. */
    readonly presets?: readonly string[];
    /** Ordered custom rules, carried to the guard in the same header as the denylist. */
    readonly rules?: readonly WafCustomRule[];
    readonly requireLogin?: boolean;
    /** Where the guard sends a visitor to sign in. Carried per route because the guard's
     *  own environment is written when its sidecar is deployed and cannot follow the
     *  address an operator configures for Polaris afterwards. */
    readonly loginUrl?: string;
    /** One principal list per scope that named who its login admits; a visitor must
     *  satisfy every one. Empty means any account, so it changes nothing on its own. */
    readonly loginAllowLists?: readonly (readonly WafPrincipalGrant[])[];
    /** Principals refused whatever admits them, unioned across scopes. */
    readonly loginDeny?: readonly WafPrincipalGrant[];
    /** Refuse requests whose headers do not hold together as a browser's. Needs the
     *  guard, like the denylist and the custom rules. */
    readonly browserIntegrity?: boolean;
    /** Refuse requests whose URL carries a SQL injection payload, and the same for a
     *  cross-site scripting one. Both need the guard, and both are on by default - so
     *  in practice they are what puts the guard in front of a service that has no other
     *  rule on it. */
    readonly sqlInjectionProtection?: boolean;
    readonly xssProtection?: boolean;
    /**
     * Rewrite email addresses in served HTML.
     *
     * Carried to the guard for completeness, and NOT materialized into a route here -
     * which is the one place this builder cannot match what the local edge does, so it
     * is written down rather than left to be discovered.
     *
     * Obfuscation needs the route to dial the guard's proxy instead of the container.
     * The local edge expresses that with the file provider's `loadBalancer.server.url`.
     * These are docker-provider labels, where the address is derived from the container
     * Traefik found rather than stated, so there is no equivalent to point elsewhere.
     * Reaching parity means giving an enrolled server's Traefik a file provider too,
     * which is an onboarding change and a Traefik restart on every existing server.
     * Until then a service on a remote server is routed direct and simply is not
     * obfuscated; nothing else about its firewall differs.
     */
    readonly emailObfuscation?: boolean;
    /** Ask visitors for proof of a browser. Needs the guard, like the denylist. */
    readonly challenge?: boolean;
}

export interface TraefikServiceInput {
    /** Router/service base name (the container/service name). */
    readonly serviceName: string;
    /** Shared proxy network Traefik and the service both join. */
    readonly network: string;
    readonly domains: readonly TraefikDomain[];
    /** WAF rules to enforce at this service's edge (allowlist + denylist + login). */
    readonly waf?: TraefikWaf;
    /** Rate limits, concurrency, security headers, redirects and rewrites - the same
     *  settings the local edge renders into its file, so a service answers the same
     *  way whichever edge serves it. */
    readonly edge?: AppEdgeConfig;
    /** How many copies run. Every copy carries these same labels, so the edge merges
     *  them into one service it balances over; a health check only has somewhere
     *  else to send traffic when there is more than one. */
    readonly replicas?: number;
}

/** The cookie a sticky service pins each visitor to one replica with. */
export const STICKY_COOKIE = "polaris_lb";

/** Traefik's ACME resolver name, configured in the static Traefik config. */
const LE_RESOLVER = "letsencrypt";
const WEB = "web";
const WEBSECURE = "websecure";

/** Base URL of the co-located edge guard, addressed by its service name on the
 *  server's own proxy network (so a remote edge points at its own guard). */
function guardUrl(): string {
    return process.env.POLARIS_EDGE_GUARD_URL ?? "http://polaris-edge-guard:8080";
}

/** True if a WAF rule needs the forwardAuth guard (has a denylist, rule packs, custom
 *  rules, or requires login). An allowlist alone is enforced by Traefik itself. */
function wafNeedsGuard(waf: TraefikWaf): boolean {
    return (
        (waf.deny?.length ?? 0) > 0 ||
        (waf.presets?.length ?? 0) > 0 ||
        (waf.rules?.length ?? 0) > 0 ||
        waf.requireLogin === true ||
        waf.browserIntegrity === true ||
        waf.sqlInjectionProtection === true ||
        waf.xssProtection === true ||
        waf.challenge === true
    );
}

/**
 * Define this service's WAF middlewares as labels and return the names to attach.
 * `app` middlewares gate the app-serving (websecure) router; `http` middlewares gate
 * the redirect router (allowlist only - the guard runs on the canonical https URL).
 * Names carry the `@docker` provider suffix, matching how routers reference them.
 */
function wafMiddlewares(
    serviceName: string,
    waf: TraefikWaf,
    labels: Record<string, string>
): { app: string[]; http: string[] } {
    const app: string[] = [];
    const http: string[] = [];
    (waf.allowLists ?? []).forEach((allow, index) => {
        if (allow.length === 0) return;
        const mw = `${serviceName}-waf-allow-${index}`;
        labels[`traefik.http.middlewares.${mw}.ipallowlist.sourcerange`] = allow.join(",");
        app.push(`${mw}@docker`);
        http.push(`${mw}@docker`);
    });
    if (wafNeedsGuard(waf)) {
        const ctx = `${serviceName}-waf-ctx`;
        labels[`traefik.http.middlewares.${ctx}.headers.customrequestheaders.X-Polaris-Waf`] =
            encodeGuardRule({
                deny: waf.deny ?? [],
                presets: waf.presets ?? [],
                rules: waf.rules ?? [],
                requireLogin: waf.requireLogin === true,
                loginUrl: waf.loginUrl,
                loginAllowLists: waf.loginAllowLists ?? [],
                loginDeny: waf.loginDeny ?? [],
                browserIntegrity: waf.browserIntegrity === true,
                sqlInjectionProtection: waf.sqlInjectionProtection === true,
                xssProtection: waf.xssProtection === true,
                emailObfuscation: waf.emailObfuscation === true,
                challenge: waf.challenge === true
            });
        labels["traefik.http.middlewares.polaris-waf-guard.forwardauth.address"] =
            `${guardUrl()}/authz`;
        app.push(`${ctx}@docker`, "polaris-waf-guard@docker");
    }
    return { app, http };
}

/**
 * The rank of a label router, stated rather than left to rule length - the same
 * ordering the local edge's file uses, so an exact hostname beats a wildcard over it
 * and a path beats its hostname. Below the 100 a pushed route takes, which is what
 * lets Polaris' pushed configuration win over these when both exist.
 */
function labelRank(domain: TraefikDomain, bump = 0): number {
    return 40 + (domain.pathPrefix ? 5 : 0) - (isWildcardHostname(domain.hostname) ? 20 : 0) + bump;
}

/** A hostname as a matcher: `Host()` for a name, and a one-label regular expression
 *  for a wildcard, which is what a wildcard certificate covers. */
function hostMatcher(hostname: string): string {
    if (!isWildcardHostname(hostname)) return `Host(\`${hostname}\`)`;
    return `HostRegexp(\`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.]${hostname.slice(2).replace(/\./g, "[.]")}$\`)`;
}

/** A path prefix safe to write into a rule. */
const PATH_PREFIX = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

/** Where a limit counts a visitor; see the local edge's `sourceByIp`. */
function ipSource(labels: Record<string, string>, prefix: string, domain: TraefikDomain): void {
    labels[`${prefix}.sourcecriterion.ipstrategy.depth`] =
        domain.certResolver === "none" ? "1" : "0";
}

/**
 * The edge middlewares a service asked for, as labels, split by where they sit in
 * the chain. Mirrors `edgeChain` in the local router; the two are kept apart only
 * because one writes a file and the other writes labels.
 */
function edgeMiddlewares(
    serviceName: string,
    edge: AppEdgeConfig,
    domain: TraefikDomain,
    siblings: ReadonlySet<string>,
    labels: Record<string, string>
): { early: string[]; late: string[]; byPath: { path: string; middleware: string }[] } {
    const early: string[] = [];
    const late: string[] = [];
    const byPath: { path: string; middleware: string }[] = [];
    const mwKey = (name: string) => `traefik.http.middlewares.${name}`;

    edge.rateLimits.forEach((limit, index) => {
        const name = `${serviceName}-rate-${index}`;
        labels[`${mwKey(name)}.ratelimit.average`] = String(limit.average);
        labels[`${mwKey(name)}.ratelimit.period`] = limit.period;
        labels[`${mwKey(name)}.ratelimit.burst`] = String(limit.burst);
        if (limit.key === "header" && limit.header) {
            labels[`${mwKey(name)}.ratelimit.sourcecriterion.requestheadername`] = limit.header;
        } else {
            ipSource(labels, `${mwKey(name)}.ratelimit`, domain);
        }
        if (limit.path) byPath.push({ path: limit.path, middleware: `${name}@docker` });
        else early.push(`${name}@docker`);
    });
    if (edge.concurrency > 0) {
        const name = `${serviceName}-inflight`;
        labels[`${mwKey(name)}.inflightreq.amount`] = String(edge.concurrency);
        if (edge.concurrencyScope === "service") {
            labels[`${mwKey(name)}.inflightreq.sourcecriterion.requesthost`] = "true";
        } else {
            ipSource(labels, `${mwKey(name)}.inflightreq`, domain);
        }
        early.push(`${name}@docker`);
    }
    const headers = Object.entries(securityHeaderMap(edge.headers));
    if (headers.length > 0) {
        const name = `${serviceName}-headers`;
        for (const [key, value] of headers)
            labels[`${mwKey(name)}.headers.customresponseheaders.${key}`] = value;
        late.push(`${name}@docker`);
    }
    const hostname = domain.hostname;
    edge.redirects.forEach((redirect, index) => {
        let regex: string | null = null;
        let replacement: string | null = null;
        if (redirect.kind === "www-to-apex") {
            if (hostname.startsWith("www.") && siblings.has(hostname.slice(4))) {
                regex = "^(https?)://www\\.([^/:]+)(.*)$";
                replacement = "${1}://${2}${3}";
            }
        } else if (redirect.kind === "apex-to-www") {
            if (
                !hostname.startsWith("www.") &&
                !isWildcardHostname(hostname) &&
                siblings.has(`www.${hostname}`)
            ) {
                regex = "^(https?)://([^/:]+)(.*)$";
                replacement = "${1}://www.${2}${3}";
            }
        } else if (redirect.regex && redirect.replacement) {
            regex = redirect.regex;
            replacement = redirect.replacement;
        }
        if (regex === null || replacement === null) return;
        const name = `${serviceName}-redirect-${index}`;
        labels[`${mwKey(name)}.redirectregex.regex`] = regex;
        labels[`${mwKey(name)}.redirectregex.replacement`] = replacement;
        labels[`${mwKey(name)}.redirectregex.permanent`] = redirect.permanent ? "true" : "false";
        late.push(`${name}@docker`);
    });
    edge.rewrites.forEach((rewrite, index) => {
        const name = `${serviceName}-rewrite-${index}`;
        if (rewrite.kind === "strip-prefix" && rewrite.prefix) {
            labels[`${mwKey(name)}.stripprefix.prefixes`] = rewrite.prefix;
        } else if (rewrite.kind === "add-prefix" && rewrite.prefix) {
            labels[`${mwKey(name)}.addprefix.prefix`] = rewrite.prefix;
        } else if (rewrite.kind === "replace-path" && rewrite.regex && rewrite.replacement) {
            labels[`${mwKey(name)}.replacepathregex.regex`] = rewrite.regex;
            labels[`${mwKey(name)}.replacepathregex.replacement`] = rewrite.replacement;
        } else {
            return;
        }
        late.push(`${name}@docker`);
    });
    return { early, late, byPath };
}

/** Build the Traefik label set for a service with zero or more domains. */
export function traefikLabels(input: TraefikServiceInput): Record<string, string> {
    // A stored hostname or path that could break a rule is left out rather than
    // written into the container's labels, where the edge would refuse it.
    const domains = input.domains.flatMap((domain) => {
        const hostname = normalizeDeployHostname(domain.hostname);
        if (!hostname || (domain.pathPrefix !== undefined && !PATH_PREFIX.test(domain.pathPrefix)))
            return [];
        return [{ ...domain, hostname }];
    });
    if (domains.length === 0) return {};
    const labels: Record<string, string> = {
        "traefik.enable": "true",
        "traefik.docker.network": input.network,
        [`traefik.http.services.${input.serviceName}.loadbalancer.server.port`]: String(
            domains[0]!.targetPort
        )
    };
    const balancer = `traefik.http.services.${input.serviceName}.loadbalancer`;
    if (input.edge?.balancing?.sticky) {
        labels[`${balancer}.sticky.cookie.name`] = STICKY_COOKIE;
        labels[`${balancer}.sticky.cookie.httponly`] = "true";
        labels[`${balancer}.sticky.cookie.samesite`] = "lax";
    }
    // One copy failing its check would leave the edge nothing to send to, which is a
    // worse answer than the copy's own.
    const healthPath = input.edge?.balancing?.healthPath;
    if (healthPath && (input.replicas ?? 1) > 1) {
        labels[`${balancer}.healthcheck.path`] = healthPath;
        labels[`${balancer}.healthcheck.interval`] = "10s";
        labels[`${balancer}.healthcheck.timeout`] = "3s";
    }
    // WAF middlewares are per-service (one app -> one rule), shared by every domain.
    const waf = input.waf
        ? wafMiddlewares(input.serviceName, input.waf, labels)
        : { app: [], http: [] };
    const siblings = new Set(domains.map((domain) => domain.hostname));
    domains.forEach((domain, index) => {
        const router = domains.length === 1 ? input.serviceName : `${input.serviceName}-${index}`;
        const rule = [
            hostMatcher(domain.hostname),
            ...(domain.pathPrefix ? [`PathPrefix(\`${domain.pathPrefix}\`)`] : [])
        ].join(" && ");
        const edge = input.edge
            ? edgeMiddlewares(
                  domains.length === 1 ? input.serviceName : router,
                  input.edge,
                  domain,
                  siblings,
                  labels
              )
            : { early: [], late: [], byPath: [] };
        // The allowlist first, then the flood limits, then the guard, then what the
        // service asked to change about its answers - the local edge's order.
        const allow = waf.http;
        const guard = waf.app.filter((name) => !allow.includes(name));
        const chain = [...allow, ...edge.early, ...guard, ...edge.late];
        const secure = domain.certResolver !== "none";
        const setRouter = (
            name: string,
            routerRule: string,
            rank: number,
            middlewares: string[]
        ) => {
            labels[`traefik.http.routers.${name}.rule`] = routerRule;
            labels[`traefik.http.routers.${name}.entrypoints`] = secure ? WEBSECURE : WEB;
            labels[`traefik.http.routers.${name}.priority`] = String(rank);
            labels[`traefik.http.routers.${name}.service`] = input.serviceName;
            if (middlewares.length > 0)
                labels[`traefik.http.routers.${name}.middlewares`] = middlewares.join(",");
            if (!secure) return;
            labels[`traefik.http.routers.${name}.tls`] = "true";
            // A wildcard has no single name to order a certificate for over HTTP.
            if (domain.certResolver === "le" && !isWildcardHostname(domain.hostname)) {
                labels[`traefik.http.routers.${name}.tls.certresolver`] = LE_RESOLVER;
            }
        };
        setRouter(router, rule, labelRank(domain), chain);
        edge.byPath.forEach((scoped, pathIndex) => {
            setRouter(
                `${router}-path-${pathIndex}`,
                `${rule} && PathPrefix(\`${scoped.path}\`)`,
                labelRank(domain, 1),
                [...chain, scoped.middleware]
            );
        });
        if (!secure) return;
        // An http router that redirects to https, behind the allowlist and the limits.
        labels[`traefik.http.routers.${router}-web.rule`] = rule;
        labels[`traefik.http.routers.${router}-web.entrypoints`] = WEB;
        labels[`traefik.http.routers.${router}-web.priority`] = String(labelRank(domain));
        labels[`traefik.http.routers.${router}-web.middlewares`] = [
            ...allow,
            ...edge.early,
            "polaris-redirect-https@docker"
        ].join(",");
        labels[`traefik.http.routers.${router}-web.service`] = input.serviceName;
    });
    // The redirect middleware itself (idempotent; Traefik dedupes by name).
    labels["traefik.http.middlewares.polaris-redirect-https.redirectscheme.scheme"] = "https";
    return labels;
}

/** Stable hash of a label map, order-independent, for lastAppliedHash. */
export function configHash(labels: Record<string, string>): string {
    const canonical = Object.keys(labels)
        .sort()
        .map((key) => `${key}=${labels[key]}`)
        .join("\n");
    return createHash("sha256").update(canonical).digest("hex");
}
