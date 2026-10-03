/**
 * Whether a service gets the port-80 forwarder beside it.
 *
 * The forwarder is what lets `http://api.polaris.internal` reach a web service
 * listening on 3000 without the port (see `@polaris/deploy`'s `private-names`).
 * That is a promise about HTTP, and only a web service can keep it. A game
 * server's 25565, a database's 5432, a broker's 1883 speak protocols where
 * "port 80" means nothing, so a forwarder in front of one answers nobody - and it
 * shares the service's network namespace, so it exits and restarts with every
 * restart of the service. Beside a crash-looping Minecraft server that was a
 * second container restarting every few seconds, for a port nothing will ever
 * call.
 *
 * Decided from what the service already records, so it holds for services
 * deployed before this existed:
 *
 * - a pinned host port is a service people reach by typing an address into a
 *   client (every game server is installed that way) - not HTTP;
 * - a main port published as UDP is not HTTP;
 * - a one-click app whose catalogue entry declares its port as TCP or UDP is not
 *   HTTP.
 *
 * Everything else - a service built from a repository, an image somebody
 * deployed, a catalogue app declaring HTTP - is a web service, as it always was.
 */

/** The source settings that answer it. */
export interface PortlessSource {
    readonly hostPort?: unknown;
    readonly hostProtocol?: unknown;
}

export function speaksHttp(
    source: PortlessSource,
    /** The protocol the service's catalogue entry declares for its main port,
     *  when it was installed from the catalogue. */
    declared: "http" | "tcp" | "udp" | undefined
): boolean {
    if (typeof source.hostPort === "number") return false;
    if (source.hostProtocol === "udp") return false;
    return declared === undefined || declared === "http";
}
