/**
 * Idempotent server-onboarding script. Streamed over SSH to a freshly added
 * remote server to make it ready to run Polaris deployments: install Docker if
 * missing, create the shared proxy network, prepare the deploy/volume roots, and
 * start a Traefik proxy with Let's Encrypt. Pure - it only builds the script text;
 * the caller runs it and streams the output. Written to be safe to re-run.
 *
 * **The edge it starts belongs to the server, not to Polaris.** That is the whole
 * design: a domain on a remote server resolves to that server and is served by
 * that server's Traefik, so an app deployed there keeps answering when the control
 * plane is switched off, unreachable, or at the end of somebody's home broadband.
 * Polaris pushes configuration to it and is never in the request path.
 *
 * Two providers, because they answer different halves of that. The **docker**
 * provider reads the labels a deployed container carries, which is what makes a
 * service routed and firewalled the moment it starts, with nothing to push. The
 * **file** provider reads a directory Polaris writes into over SSH, which is where
 * anything a label cannot express goes - a route that has to dial somewhere other
 * than the container it describes, which is what response rewriting needs.
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

/**
 * Where this server's edge reads the routes Polaris pushes it.
 *
 * Exported because the thing that writes into it over SSH has to name the same
 * directory, and two spellings of a path is how a route silently lands nowhere.
 */
export const DYNAMIC_DIR = "/var/lib/polaris/traefik/dynamic";

const DEFAULT_DEPLOY_ROOT = "/var/lib/polaris/deploy";
const DEFAULT_VOLUME_ROOT = "/var/lib/polaris/volumes";
const DEFAULT_TRAEFIK_IMAGE = "traefik:v3.1";
const DEFAULT_GUARD_IMAGE = "ghcr.io/fjrg2007/polaris-edge-guard:latest";

/**
 * The builder that turns a repository with no Dockerfile into an image, and the
 * version Polaris expects of it.
 *
 * Pinned and upgraded rather than "whatever is on the box", because this one
 * choice decides which language runtimes exist. A nixpacks from 2024 knows Node
 * 18, 20 and 22 and pins each to one release from its own era; a project asking
 * for Node >=22.12 gets 22.3 and fails its own engine check, and asking that old
 * build for a newer major does not error - it silently falls back to Node 18.
 * Every workaround for that is a worse version of upgrading the tool.
 */
export const NIXPACKS_VERSION = "1.41.0";

/** The one line that brings a machine's builder up to what Polaris expects.
 *  Shown wherever a build fails for want of it, because the operator reading that
 *  is already on a shell and the useful thing to hand them is the command. */
export const BUILDER_UPGRADE_COMMAND = `NIXPACKS_VERSION=${NIXPACKS_VERSION} bash -c "$(curl -fsSL https://nixpacks.com/install.sh)"`;

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
        // The builder for repositories with no Dockerfile. Upgraded when it is
        // older than the pin, not merely installed when absent: a machine set up a
        // year ago carries a build that cannot produce a current language runtime,
        // and nothing about that is visible until somebody's app fails its own
        // engine check.
        'echo "== build toolchain =="',
        `NIXPACKS_WANT=${NIXPACKS_VERSION}`,
        'NIXPACKS_HAVE="$(nixpacks --version 2>/dev/null | awk \'{print $2}\')"',
        'if [ "$NIXPACKS_HAVE" != "$NIXPACKS_WANT" ]; then',
        '  echo "installing nixpacks $NIXPACKS_WANT (found: ${NIXPACKS_HAVE:-none})";',
        // The installer reads the version it should fetch from the environment.
        "  NIXPACKS_VERSION=\"$NIXPACKS_WANT\" bash -c \"$(curl -fsSL https://nixpacks.com/install.sh)\";",
        "fi",
        "nixpacks --version",
        `mkdir -p ${deployRoot} ${volumeRoot} /var/lib/polaris/traefik ${DYNAMIC_DIR}`,
        `docker network inspect ${net} >/dev/null 2>&1 || docker network create ${net}`,
        'echo "== starting Traefik =="',
        "docker rm -f polaris-traefik >/dev/null 2>&1 || true",
        [
            "docker run -d --name polaris-traefik --restart unless-stopped",
            `--network ${net}`,
            "-p 80:80 -p 443:443",
            "-v /var/run/docker.sock:/var/run/docker.sock:ro",
            "-v /var/lib/polaris/traefik:/traefik",
            `-v ${DYNAMIC_DIR}:/dynamic`,
            image,
            "--providers.docker=true",
            "--providers.docker.exposedbydefault=false",
            `--providers.docker.network=${net}`,
            // Watched rather than read once: Polaris writes into this directory
            // over SSH long after the container started, and a restart to pick up
            // a routing change would be an outage per change.
            "--providers.file.directory=/dynamic",
            "--providers.file.watch=true",
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
