/**
 * Idempotent server-onboarding script. Streamed over SSH to a freshly added
 * remote server to make it ready to run Polaris deployments: install Docker if
 * missing, create the shared proxy network, prepare the deploy/volume roots, and
 * start a Traefik proxy with Let's Encrypt. Pure - it only builds the script text;
 * the caller runs it and streams the output. Written to be safe to re-run.
 */

import { quoteArg } from "./shell.js";

export interface OnboardingOptions {
    /** Shared proxy network name (must match the target's proxyNetwork). */
    readonly proxyNetwork: string;
    /** Contact email for Let's Encrypt registration. */
    readonly acmeEmail: string;
    readonly deployRoot?: string;
    readonly volumeRoot?: string;
    readonly traefikImage?: string;
    /** Image for the co-located WAF sentinel Traefik forwardAuths to. */
    readonly guardImage?: string;
    /** Shared HMAC secret (POLARIS_AUTH_SECRET) so the guard verifies edge tokens
     *  offline. When omitted, the guard is not started - allowlist-only WAF rules
     *  still work natively, but denylist/require-login rules need this. */
    readonly authSecret?: string;
    /** Polaris base URL the guard redirects to for require-login sign-in. */
    readonly publicUrl?: string;
}

const DEFAULT_DEPLOY_ROOT = "/var/lib/polaris/deploy";
const DEFAULT_VOLUME_ROOT = "/var/lib/polaris/volumes";
const DEFAULT_TRAEFIK_IMAGE = "traefik:v3.1";
const DEFAULT_GUARD_IMAGE = "ghcr.io/fjrg2007/polaris-edge-guard:latest";

/** Build the onboarding bash script for a remote server. */
export function onboardingScript(options: OnboardingOptions): string {
    const deployRoot = options.deployRoot ?? DEFAULT_DEPLOY_ROOT;
    const volumeRoot = options.volumeRoot ?? DEFAULT_VOLUME_ROOT;
    const image = options.traefikImage ?? DEFAULT_TRAEFIK_IMAGE;
    const guardImage = options.guardImage ?? DEFAULT_GUARD_IMAGE;
    const net = options.proxyNetwork;
    // The WAF sentinel only starts when a secret is provided; it verifies edge login
    // tokens offline (deny-only rules need no secret but the guard still serves them).
    // Named polaris-edge-guard so the generated forwardAuth address resolves on the
    // proxy network. Not published - reachable only from this server's Traefik.
    const guardSteps = options.authSecret
        ? [
              'echo "== starting WAF guard =="',
              "docker rm -f polaris-edge-guard >/dev/null 2>&1 || true",
              [
                  "docker run -d --name polaris-edge-guard --restart unless-stopped",
                  `--network ${net}`,
                  `-e POLARIS_AUTH_SECRET=${quoteArg(options.authSecret)}`,
                  `-e POLARIS_PUBLIC_URL=${quoteArg(options.publicUrl ?? "")}`,
                  guardImage
              ].join(" ")
          ]
        : [];
    // acmeEmail is validated by the caller; it is only used as a CLI flag value.
    return [
        "set -e",
        'echo "== Polaris server setup =="',
        "if ! command -v docker >/dev/null 2>&1; then",
        '  echo "installing docker...";',
        "  curl -fsSL https://get.docker.com | sh;",
        "fi",
        "docker --version",
        `mkdir -p ${deployRoot} ${volumeRoot} /var/lib/polaris/traefik`,
        `docker network inspect ${net} >/dev/null 2>&1 || docker network create ${net}`,
        'echo "== starting Traefik =="',
        `docker rm -f polaris-traefik >/dev/null 2>&1 || true`,
        [
            "docker run -d --name polaris-traefik --restart unless-stopped",
            `--network ${net}`,
            "-p 80:80 -p 443:443",
            "-v /var/run/docker.sock:/var/run/docker.sock:ro",
            "-v /var/lib/polaris/traefik:/traefik",
            image,
            "--providers.docker=true",
            "--providers.docker.exposedbydefault=false",
            `--providers.docker.network=${net}`,
            "--entrypoints.web.address=:80",
            "--entrypoints.websecure.address=:443",
            "--certificatesresolvers.letsencrypt.acme.httpchallenge=true",
            "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web",
            `--certificatesresolvers.letsencrypt.acme.email=${options.acmeEmail}`,
            "--certificatesresolvers.letsencrypt.acme.storage=/traefik/acme.json"
        ].join(" "),
        ...guardSteps,
        'echo "== done =="'
    ].join("\n");
}
