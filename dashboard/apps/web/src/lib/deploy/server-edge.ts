/**
 * Making a connected server able to serve its own domains.
 *
 * A server Polaris deploys to needs three things of its own before a hostname
 * pointed at it answers anything: Docker with the shared proxy network, a Traefik
 * holding ports 80 and 443, and the small guard Traefik asks about a request the
 * firewall has an opinion on. All three run **on that server**. Polaris installs
 * them, configures them and then stays out of the way - so an app in a data centre
 * keeps serving while the control plane at the end of somebody's home broadband is
 * off, unreachable, or being updated.
 *
 * The script that does it has existed and been tested since the first version of
 * Deploy, and nothing ever ran it: a host was adopted as a deploy target the first
 * time somebody deployed to it, and the edge it needed was left as an exercise.
 * Which is why a domain on a remote server resolved and then answered nothing.
 *
 * Two things worth knowing before changing this.
 *
 * **Preparing is not free.** It replaces the Traefik container, so a server that
 * is already serving stops for the second or two that takes. That is said on the
 * screen rather than hidden, because the operator is the one who knows whether now
 * is a good time.
 *
 * **It is safe to run again, and often has to be.** A server prepared by an older
 * Polaris has a Traefik that reads container labels and nothing else, which is
 * enough to serve a site and not enough to be given a route or a firewall change
 * without redeploying it. Running it again is how that is fixed, and the only way
 * to tell is to ask - so `readServerEdge` asks.
 *
 * Server-only.
 */

import { loadEnv } from "@polaris/config";
import { onboardingScript } from "@polaris/deploy";
import { publicAppUrl } from "@/lib/domain-service";
import { getHostConnection } from "@/lib/host-service";
import { execCommand, openSshClient } from "@polaris/ssh";

/** What a server's edge looks like right now. */
export interface ServerEdgeState {
    /** Whether this server's own Traefik is running. */
    readonly traefik: boolean;
    /** Whether the firewall's decision-maker is running beside it. Without it a
     *  denylist, a rule pack or a require-login rule cannot be enforced there -
     *  an address allowlist still can, because Traefik does that itself. */
    readonly guard: boolean;
    /** Whether that Traefik reads the directory Polaris pushes routes into. An
     *  edge without it still serves everything deployed to it; what it cannot do
     *  is take a domain or a firewall change without the service being rebuilt. */
    readonly pushable: boolean;
    /** Why the server could not be asked, where it could not. Its own words. */
    readonly error: string | null;
}

const UNREACHABLE: ServerEdgeState = {
    traefik: false,
    guard: false,
    pushable: false,
    error: null
};

/**
 * One read-only question, asked in one connection.
 *
 * Printed as `key=value` lines rather than parsed out of `docker inspect` JSON on
 * this side: what comes back is a shell's output on somebody else's machine, and
 * the smaller the thing being parsed the fewer ways there are for a stray line of
 * MOTD to be read as an answer.
 */
const PROBE = [
    "printf 'traefik=%s\\n' \"$(docker inspect -f '{{.State.Running}}' polaris-traefik 2>/dev/null || echo none)\"",
    "printf 'guard=%s\\n' \"$(docker inspect -f '{{.State.Running}}' polaris-edge-guard 2>/dev/null || echo none)\"",
    "if docker inspect -f '{{json .Args}}' polaris-traefik 2>/dev/null | grep -q 'providers.file.directory'; then printf 'pushable=true\\n'; else printf 'pushable=false\\n'; fi"
].join("\n");

/** What the probe said, out of its own output. Anything unrecognised is false,
 *  which is the answer that offers to fix it rather than the one that hides it. */
export function readEdgeProbe(output: string): Omit<ServerEdgeState, "error"> {
    const said = (key: string): string => {
        const found = output.split(/\r?\n/).find((line) => line.trim().startsWith(`${key}=`));
        return found ? found.trim().slice(key.length + 1) : "";
    };
    return {
        traefik: said("traefik") === "true",
        guard: said("guard") === "true",
        pushable: said("pushable") === "true"
    };
}

export async function readServerEdge(hostId: string, ownerId: string): Promise<ServerEdgeState> {
    try {
        const connection = await getHostConnection(hostId, ownerId);
        const client = await openSshClient({
            host: connection.address,
            port: connection.port,
            username: connection.username,
            auth: connection.auth,
            pinnedHostKey: connection.hostKey
        });
        try {
            let said = "";
            await execCommand(client, PROBE, {
                onStdout: (chunk) => {
                    said += chunk.toString("utf8");
                }
            });
            return { ...readEdgeProbe(said), error: null };
        } finally {
            client.end();
        }
    } catch (error) {
        // A server that is asleep or has moved is not a server with a broken edge,
        // and the screen has to be able to say which of the two it is looking at.
        return { ...UNREACHABLE, error: error instanceof Error ? error.message : "It could not be reached" };
    }
}

/**
 * Install, or repair, everything this server needs to serve its own domains.
 *
 * The guard is only started when there is a secret to give it, because the whole
 * of what it does is verify things Polaris signed. Without one it would refuse
 * every request it was asked about, which is worse than not being there: an
 * address allowlist is enforced by Traefik either way.
 */
export async function prepareServerEdge(
    hostId: string,
    ownerId: string,
    proxyNetwork: string,
    onOutput?: (chunk: string) => void
): Promise<void> {
    const env = loadEnv();
    const connection = await getHostConnection(hostId, ownerId);
    const script = onboardingScript({
        proxyNetwork,
        // Where Let's Encrypt writes about an expiring certificate. Their own
        // registration requires one; an empty string is refused by the API, so the
        // operator setting it is what makes a certificate possible at all.
        acmeEmail: env.POLARIS_ACME_EMAIL || "",
        authSecret: env.POLARIS_AUTH_SECRET || undefined,
        // Where the guard sends somebody to sign in for a require-login rule. Only
        // an address reachable from wherever that visitor is, which is what
        // `publicAppUrl` answers null for when there is none - and then the guard
        // is started without one rather than with a LAN name nobody outside can
        // open.
        publicUrl: (await publicAppUrl().catch(() => null)) ?? ""
    });

    const client = await openSshClient({
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        pinnedHostKey: connection.hostKey
    });
    try {
        let complaint = "";
        const result = await execCommand(client, script, {
            onStdout: (chunk) => onOutput?.(chunk.toString("utf8")),
            onStderr: (chunk) => {
                const text = chunk.toString("utf8");
                complaint += text;
                onOutput?.(text);
            }
        });
        if (result.code !== 0) {
            throw new Error(
                complaint.trim().split(/\r?\n/).at(-1)?.slice(0, 200) ||
                    "That server refused to set itself up"
            );
        }
    } finally {
        client.end();
    }
}
