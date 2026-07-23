/**
 * Traefik routing config as container labels. Traefik's docker provider discovers
 * a deployed service by these labels on the shared proxy network, so routing is
 * decoupled from any central table and works identically for compose and swarm.
 * Pure: given a service name, network, and its domains, produce the label map (and
 * a stable hash of it for idempotency/drift detection).
 */

import { createHash } from "node:crypto";
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
    readonly requireLogin?: boolean;
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

/** True if a WAF rule needs the forwardAuth guard (has a denylist or requires login). */
function wafNeedsGuard(waf: TraefikWaf): boolean {
    return (waf.deny?.length ?? 0) > 0 || waf.requireLogin === true;
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
            requireLogin: waf.requireLogin === true
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
