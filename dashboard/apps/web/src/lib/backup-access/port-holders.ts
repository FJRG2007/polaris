/**
 * Who is holding a relay server's web ports, read from what the server printed.
 *
 * Pure, so the card can ask whether Polaris may offer to free them.
 */

/** Web servers Polaris may stop to take their ports. A container or anything else
 *  is somebody's running work with no one obvious way to move it, so it is only named. */
export const FREEABLE_SERVICES = ["nginx", "apache2", "httpd", "caddy", "lighttpd", "haproxy"];

/** Said when the server would not name the listener. */
export const UNKNOWN_HOLDER = "unknown";

/** Polaris' own edge and Docker's port forwarder, which stands in for a container
 *  that is named on its own line. */
const NOT_HOLDERS = new Set(["docker-proxy", "polaris-traefik"]);

/**
 * The holders in the server's answer: `ss` listener lines and `container=` lines.
 * Sorted and unique; empty when the ports are free or only Polaris holds them.
 */
export function readPortHolders(output: string): string[] {
    const holders = new Set<string>();
    for (const raw of output.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith("container=")) holders.add(line.slice("container=".length));
        else if (/^LISTEN\s/.test(line))
            holders.add(/users:\(\("([^"]+)"/.exec(line)?.[1] ?? UNKNOWN_HOLDER);
    }
    return [...holders].filter((name) => name && !NOT_HOLDERS.has(name)).sort();
}

/** Whether every holder is a web server Polaris may stop. */
export function holdersCanBeFreed(holders: readonly string[]): boolean {
    return holders.length > 0 && holders.every((name) => FREEABLE_SERVICES.includes(name));
}
