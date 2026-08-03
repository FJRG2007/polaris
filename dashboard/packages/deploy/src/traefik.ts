/**
 * Traefik routing config as container labels. Traefik's docker provider discovers
 * a deployed service by these labels on the shared proxy network, so routing is
 * decoupled from any central table and works identically for compose and swarm.
 * Pure: given a service name, network, and its domains, produce the label map (and
 * a stable hash of it for idempotency/drift detection).
 */

import { createHash } from "node:crypto";
import type { WafCustomRule } from "@polaris/core";
import { encodeGuardRule } from "@polaris/core/waf";

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
}

export interface TraefikServiceInput {
    /** Router/service base name (the container/service name). */
    readonly serviceName: string;
    /** Shared proxy network Traefik and the service both join. */
    readonly network: string;
    readonly domains: readonly TraefikDomain[];
    /** WAF rules to enforce at this service's edge (allowlist + denylist + login). */
    readonly waf?: TraefikWaf;
}

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
        waf.xssProtection === true
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
        labels[`traefik.http.middlewares.${ctx}.headers.customrequestheaders.X-Polaris-Waf`] = encodeGuardRule({
            deny: waf.deny ?? [],
            presets: waf.presets ?? [],
            rules: waf.rules ?? [],
            requireLogin: waf.requireLogin === true,
            browserIntegrity: waf.browserIntegrity === true,
            sqlInjectionProtection: waf.sqlInjectionProtection === true,
            xssProtection: waf.xssProtection === true,
            emailObfuscation: waf.emailObfuscation === true
        });
        labels["traefik.http.middlewares.polaris-waf-guard.forwardauth.address"] = `${guardUrl()}/authz`;
        app.push(`${ctx}@docker`, "polaris-waf-guard@docker");
    }
    return { app, http };
}

/** Build the Traefik label set for a service with zero or more domains. */
export function traefikLabels(input: TraefikServiceInput): Record<string, string> {
    if (input.domains.length === 0) return {};
    const labels: Record<string, string> = {
        "traefik.enable": "true",
        "traefik.docker.network": input.network,
        [`traefik.http.services.${input.serviceName}.loadbalancer.server.port`]: String(
            input.domains[0]!.targetPort
        )
    };
    // WAF middlewares are per-service (one app -> one rule), shared by every domain.
    const waf = input.waf ? wafMiddlewares(input.serviceName, input.waf, labels) : { app: [], http: [] };
    input.domains.forEach((domain, index) => {
        const router = input.domains.length === 1 ? input.serviceName : `${input.serviceName}-${index}`;
        const rule = domain.pathPrefix
            ? `Host(\`${domain.hostname}\`) && PathPrefix(\`${domain.pathPrefix}\`)`
            : `Host(\`${domain.hostname}\`)`;
        if (domain.certResolver === "none") {
            labels[`traefik.http.routers.${router}.rule`] = rule;
            labels[`traefik.http.routers.${router}.entrypoints`] = WEB;
            labels[`traefik.http.routers.${router}.service`] = input.serviceName;
            if (waf.app.length > 0) labels[`traefik.http.routers.${router}.middlewares`] = waf.app.join(",");
            return;
        }
        // TLS router on websecure, plus an http router that redirects to https.
        labels[`traefik.http.routers.${router}.rule`] = rule;
        labels[`traefik.http.routers.${router}.entrypoints`] = WEBSECURE;
        labels[`traefik.http.routers.${router}.tls`] = "true";
        labels[`traefik.http.routers.${router}.service`] = input.serviceName;
        if (waf.app.length > 0) labels[`traefik.http.routers.${router}.middlewares`] = waf.app.join(",");
        if (domain.certResolver === "le") {
            labels[`traefik.http.routers.${router}.tls.certresolver`] = LE_RESOLVER;
        }
        labels[`traefik.http.routers.${router}-web.rule`] = rule;
        labels[`traefik.http.routers.${router}-web.entrypoints`] = WEB;
        labels[`traefik.http.routers.${router}-web.middlewares`] = [...waf.http, "polaris-redirect-https@docker"].join(",");
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
