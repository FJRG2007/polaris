/**
 * Traefik routing config as container labels. Traefik's docker provider discovers
 * a deployed service by these labels on the shared proxy network, so routing is
 * decoupled from any central table and works identically for compose and swarm.
 * Pure: given a service name, network, and its domains, produce the label map (and
 * a stable hash of it for idempotency/drift detection).
 */

import { createHash } from "node:crypto";

export type CertResolver = "le" | "internal" | "none";

export interface TraefikDomain {
    readonly hostname: string;
    readonly targetPort: number;
    readonly pathPrefix?: string;
    readonly certResolver: CertResolver;
}

export interface TraefikServiceInput {
    /** Router/service base name (the container/service name). */
    readonly serviceName: string;
    /** Shared proxy network Traefik and the service both join. */
    readonly network: string;
    readonly domains: readonly TraefikDomain[];
}

/** Traefik's ACME resolver name, configured in the static Traefik config. */
const LE_RESOLVER = "letsencrypt";
const WEB = "web";
const WEBSECURE = "websecure";

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
    input.domains.forEach((domain, index) => {
        const router = input.domains.length === 1 ? input.serviceName : `${input.serviceName}-${index}`;
        const rule = domain.pathPrefix
            ? `Host(\`${domain.hostname}\`) && PathPrefix(\`${domain.pathPrefix}\`)`
            : `Host(\`${domain.hostname}\`)`;
        if (domain.certResolver === "none") {
            labels[`traefik.http.routers.${router}.rule`] = rule;
            labels[`traefik.http.routers.${router}.entrypoints`] = WEB;
            labels[`traefik.http.routers.${router}.service`] = input.serviceName;
            return;
        }
        // TLS router on websecure, plus an http router that redirects to https.
        labels[`traefik.http.routers.${router}.rule`] = rule;
        labels[`traefik.http.routers.${router}.entrypoints`] = WEBSECURE;
        labels[`traefik.http.routers.${router}.tls`] = "true";
        labels[`traefik.http.routers.${router}.service`] = input.serviceName;
        if (domain.certResolver === "le") {
            labels[`traefik.http.routers.${router}.tls.certresolver`] = LE_RESOLVER;
        }
        labels[`traefik.http.routers.${router}-web.rule`] = rule;
        labels[`traefik.http.routers.${router}-web.entrypoints`] = WEB;
        labels[`traefik.http.routers.${router}-web.middlewares`] = "polaris-redirect-https@docker";
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
