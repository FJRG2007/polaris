/**
 * The other half of the edge seam: a server that is not this one.
 *
 * Every connected server runs its own Traefik, and a domain on a remote server
 * resolves to that server. That is the whole point - an app on a data-centre box
 * must go on answering when the control plane at the end of somebody's home
 * broadband is switched off, unreachable, or being updated. Polaris pushes
 * configuration to that edge and is never in the request path.
 *
 * Most of what a service needs is already there without this: the container
 * carries Traefik labels, so the route and the firewall exist the moment it
 * starts, read by the server's own docker provider. This is for what a label
 * cannot say - a route that has to dial somewhere other than the container it
 * describes - and for being able to state a route at all when there is no
 * container to hang a label on.
 *
 * **The write is atomic, for exactly the reason the local one is.** One file is
 * how every domain on that server is reached; written in place, an interrupted
 * write leaves it empty, and an empty routing file is an edge answering `404 page
 * not found` for services that are all running perfectly. So it is written beside
 * the target and renamed over it, which a file watcher never observes half-done.
 *
 * Server-only.
 */

import { randomBytes } from "node:crypto";
import { quoteArg, DYNAMIC_DIR } from "@polaris/deploy";
import { execCommand, openSshClient, type SshAuth } from "@polaris/ssh";
import { renderDynamicConfig, type AppRoute, type Router } from "@/lib/deploy/router";

/**
 * How a pushed route ranks against the one a container declares in its own labels.
 *
 * Traefik ranks by the length of the rule unless a number says otherwise, and both
 * routes carry the same `Host(...)` rule - so without this they tie, and a tie is
 * resolved by a line in a log nobody reads. High enough to be unambiguous, and it
 * has nothing to compete with: the only other ranks on this edge are whatever a
 * deployed container's labels ask for.
 */
const PUSHED_ROUTE_PRIORITY = 100;

/** The file Polaris owns on a remote edge. Every other file in that directory is
 *  somebody else's and is never touched. */
const FILE = "polaris-apps.yml";

/** How a remote server is reached. The same shape the deploy pipeline resolves for
 *  a target, passed in rather than looked up: this module does no database work. */
export interface RemoteEdge {
    readonly address: string;
    readonly port: number;
    readonly username: string;
    readonly auth: SshAuth;
    readonly hostKey?: string;
}

/**
 * The script that puts one rendered config on a server.
 *
 * Pure, and separate from the connection, because this is the part with the
 * failure worth testing: it has to create the directory if the server was
 * prepared before the directory existed, land the bytes exactly as rendered
 * whatever the shell would otherwise do to them, and never leave a half-written
 * file where the edge is looking.
 *
 * Base64 rather than a heredoc: the payload is YAML with quotes, backticks and
 * dollars in it - Traefik rules are full of backticks - and every one of those is
 * a way for a shell to change what lands on disk.
 */
export function remoteWriteScript(yaml: string, nonce = randomBytes(6).toString("hex")): string {
    const payload = Buffer.from(yaml, "utf8").toString("base64");
    const target = `${DYNAMIC_DIR}/${FILE}`;
    const temporary = `${DYNAMIC_DIR}/.${FILE}.${nonce}`;
    return [
        "set -e",
        `mkdir -p ${quoteArg(DYNAMIC_DIR)}`,
        `printf %s ${quoteArg(payload)} | base64 -d > ${quoteArg(temporary)}`,
        // Renamed over the target rather than written into it. The file watcher
        // never sees a partial file, and a failed write leaves the last good one.
        `mv -f ${quoteArg(temporary)} ${quoteArg(target)}`
    ].join("\n");
}

/** The script that takes Polaris's file off a server - for a server that no longer
 *  runs anything of ours, so its edge stops holding routes to nothing. */
export function remoteClearScript(): string {
    return `rm -f ${quoteArg(`${DYNAMIC_DIR}/${FILE}`)}`;
}

export class RemoteRouter implements Router {
    public constructor(private readonly edge: RemoteEdge) {}

    /**
     * Replace this server's Polaris routes with exactly these.
     *
     * The guard's two extra listeners are declared unreachable, and that is a
     * decision rather than an omission: they are not published outside the
     * server's own proxy network, so Polaris cannot ask whether they answer, and
     * the cost of guessing wrong is every rewritten route becoming a 502 with a
     * healthy application behind it. A route is therefore pointed straight at its
     * service. The firewall itself is unaffected - it rides the container's own
     * labels and is enforced by that server whether or not this ever runs.
     */
    public async sync(routes: readonly AppRoute[]): Promise<void> {
        const yaml = renderDynamicConfig(routes, {
            proxyAvailable: false,
            vacantAvailable: false,
            vacantZones: [],
            // Above the route the container declares for itself. Both exist and
            // both are correct; this is the one Polaris keeps current, so it is
            // the one that has to win a tie rather than leaving Traefik to pick.
            routePriority: PUSHED_ROUTE_PRIORITY
        });
        await this.run(routes.length === 0 ? remoteClearScript() : remoteWriteScript(yaml));
    }

    private async run(script: string): Promise<void> {
        const client = await openSshClient({
            host: this.edge.address,
            port: this.edge.port,
            username: this.edge.username,
            auth: this.edge.auth,
            pinnedHostKey: this.edge.hostKey
        });
        try {
            let complaint = "";
            const result = await execCommand(client, script, {
                onStderr: (chunk) => {
                    complaint += chunk.toString("utf8");
                }
            });
            if (result.code !== 0) {
                throw new Error(
                    `That server would not take its routes${complaint.trim() ? `: ${complaint.trim().slice(0, 200)}` : ""}`
                );
            }
        } finally {
            client.end();
        }
    }
}
