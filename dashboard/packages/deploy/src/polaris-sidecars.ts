/**
 * The sidecars Polaris starts for one of its own features, told apart by their
 * compose project: which feature started each one, and - for a tunnel given to a
 * deployed service - which service it belongs to.
 *
 * One definition for every reader. The security scans screen names the feature
 * behind an image with it, and the reaper decides from it which owner a
 * container needs before it can stay. Matched exactly, never by prefix: every
 * deployed service is a `polaris-<hash>` project too. Pure.
 */

/** A feature of Polaris that runs a container of its own. */
export type SidecarFeature =
    | "tunnel-ngrok"
    | "tunnel-cloudflare"
    | "share-tunnel"
    | "backup-tunnel"
    | "app-tunnel-named"
    | "app-tunnel-quick"
    | "app-tunnel-ngrok";

export interface Sidecar {
    readonly feature: SidecarFeature;
    /** The compose project it runs under. */
    readonly project: string;
    /** For a service's tunnel: the service's own project, `polaris-<eight hex>`. */
    readonly appProject?: string;
}

/** The account-wide tunnel (Integrations > Cloudflare / ngrok). */
export const ACCOUNT_TUNNEL_PROJECT = "polaris-tunnel";
/** The tunnel that publishes Polaris's own share links. */
export const SHARE_TUNNEL_PROJECT = "polaris-ptunnel";
/** The standby tunnel of backup access. */
export const BACKUP_TUNNEL_PROJECT = "polaris-backup-tunnel";

const APP_TUNNEL = /^polaris-(ntunnel|qtunnel|ngrok)-([0-9a-f]{8})$/;
const APP_TUNNEL_FEATURE = {
    ntunnel: "app-tunnel-named",
    qtunnel: "app-tunnel-quick",
    ngrok: "app-tunnel-ngrok"
} as const;

/**
 * The feature a container was started by, from its compose project and the
 * image it was started from, or null when it is not one of these sidecars.
 *
 * The account tunnel runs one provider at a time under one project, so the
 * image is what says which: `ngrok/ngrok` or `cloudflare/cloudflared`.
 */
export function sidecarOf(project: string | null, ref: string): Sidecar | null {
    if (!project) return null;
    if (project === ACCOUNT_TUNNEL_PROJECT) {
        const feature = /(^|\/)ngrok(\/|:|$)/.test(ref) ? "tunnel-ngrok" : "tunnel-cloudflare";
        return { feature, project };
    }
    if (project === SHARE_TUNNEL_PROJECT) return { feature: "share-tunnel", project };
    if (project === BACKUP_TUNNEL_PROJECT) return { feature: "backup-tunnel", project };
    const match = APP_TUNNEL.exec(project);
    if (!match) return null;
    const kind = match[1] as keyof typeof APP_TUNNEL_FEATURE;
    return {
        feature: APP_TUNNEL_FEATURE[kind],
        project,
        appProject: `polaris-${match[2]}`
    };
}
