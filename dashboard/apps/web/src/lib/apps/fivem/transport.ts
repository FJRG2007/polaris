/**
 * How Polaris talks to a running FiveM server.
 *
 * From inside the server's own container, always. The two channels a FiveM server
 * offers - the small JSON documents it publishes over HTTP, and the console
 * protocol it answers over UDP - both live on the port players connect to, which
 * means asking from anywhere else would mean sending the console password across
 * whatever network sits between the dashboard and that machine. Inside the
 * container it never leaves the host, the address is always `127.0.0.1`, the port
 * is always the one the image bound, and it works identically for a server on this
 * machine and one on a registered server over SSH. It is the same seam Minecraft
 * and ARK are driven through, for the same reasons.
 *
 * Nothing an operator types is ever interpolated into a shell command. The console
 * datagram is built and base64-encoded here and handed to `base64 -d` on the other
 * side, so what reaches the shell is a fixed script and a string of base64
 * characters - a player name with a semicolon in it is a player name.
 *
 * The tools it needs are the ones a container has because it is a Linux userland,
 * not because anybody installed them. When one is genuinely missing the failure is
 * named rather than reported as a server that is not answering, because those need
 * completely different things doing about them.
 */

import { prisma } from "@polaris/db";
import { withTimeout } from "@polaris/core";
import { FIVEM_CONTAINER_PORT } from "@/lib/apps/fivem/config";
import { withServerContainer, type ServerContainer } from "@/lib/apps/minecraft/service";
import { isRconRefusal, isSafeCommand, parseRconReply, rconRequest } from "@/lib/apps/fivem/rcon";

/** The documents the server publishes about itself. A closed set: each is a path
 *  this module puts in a URL, so none of them is ever anything a caller composed. */
export type FivemDocument = "players.json" | "info.json" | "dynamic.json";

/** How long the server gets to answer one HTTP read, inside the container. */
const HTTP_TIMEOUT_SECONDS = 5;

/** How long to wait on the console's reply datagram. A long answer arrives as
 *  several, so this is a window rather than a deadline: the tool sits for the
 *  whole of it and hands back everything that came. */
const RCON_WAIT_SECONDS = 3;

/**
 * How long the whole exchange gets before it is abandoned.
 *
 * A command that fails comes back; a container whose connection has wedged does
 * not come back at all, and every caller here is something a person or a sweep is
 * waiting on. Comfortably above both windows above, because this is a bound on
 * hanging rather than a performance budget.
 */
const COMMAND_TIMEOUT_MS = 15_000;

/** The container had no HTTP client at all. Shared, because the same absence
 *  stops a resource being fetched into the server as stops it being read. */
export const NO_HTTP_CLIENT = 97;

/** The container had nothing that speaks UDP. */
const NO_UDP_CLIENT = 98;

/** A running FiveM server, as the things that drive one see it. */
export interface FivemTransport {
    /** Whether Polaris means the container to be up, from the deploy's own record. */
    readonly running: boolean;
    /** One of the documents the server publishes, already parsed. Null when it
     *  answered with something that is not JSON, which is what a server that is
     *  still starting says. */
    document(name: FivemDocument): Promise<unknown>;
    /** One console command, and whatever the server printed back. */
    rcon(command: string): Promise<string>;
    /** The container itself, for the files a console cannot reach. */
    readonly container: ServerContainer;
}

/**
 * Do a piece of work against one server.
 *
 * The console password is read once, on the first command that needs it, so a
 * screen that only reads the player list never touches the master key at all.
 */
export async function withFivemServer<T>(
    ownerId: string,
    installedAppId: string,
    work: (server: FivemTransport) => Promise<T>
): Promise<T> {
    return withServerContainer(ownerId, installedAppId, async (container) => {
        let password: string | null = null;
        const transport: FivemTransport = {
            running: container.running,
            container,
            document: (name) => readDocument(container, name),
            rcon: async (command) => {
                password ??= await consolePassword(container.applicationId, ownerId);
                return runRcon(container, password, command);
            }
        };
        return work(transport);
    });
}

/** One of the server's own documents, read from inside the container. */
async function readDocument(container: ServerContainer, name: FivemDocument): Promise<unknown> {
    const url = `http://127.0.0.1:${FIVEM_CONTAINER_PORT}/${name}`;
    const script = [
        `if command -v wget >/dev/null 2>&1; then exec wget -q -O - -T ${HTTP_TIMEOUT_SECONDS} "${url}"; fi`,
        `if command -v curl >/dev/null 2>&1; then exec curl -fsS --max-time ${HTTP_TIMEOUT_SECONDS} "${url}"; fi`,
        `exit ${NO_HTTP_CLIENT}`
    ].join("\n");
    const result = await withTimeout(
        container.run(["sh", "-c", script]),
        COMMAND_TIMEOUT_MS,
        "The server did not answer in time"
    );
    if (result.code === NO_HTTP_CLIENT) {
        throw new Error("This server's image has no way for Polaris to read it. Redeploy it to get the current one.");
    }
    if (result.code !== 0) throw new Error("The server is not answering yet");
    try {
        return JSON.parse(result.output) as unknown;
    } catch {
        // A server that is still loading answers the port with something that is
        // not JSON. That is a server not ready, never a broken one.
        return null;
    }
}

/**
 * Send one console command and hand back what the server printed.
 *
 * The datagram carries the password in the clear, which is the protocol rather
 * than a choice - and the reason this only ever runs against `127.0.0.1` from
 * inside the container.
 */
async function runRcon(container: ServerContainer, password: string, command: string): Promise<string> {
    if (!isSafeCommand(command)) throw new Error("That command is not valid");
    const packet = rconRequest(password, command).toString("base64");
    const script = [
        `command -v nc >/dev/null 2>&1 || exit ${NO_UDP_CLIENT}`,
        // Encoded on the way out and on the way back: the request holds bytes no
        // shell should see, and the reply begins with four that are not text.
        `printf %s ${packet} | base64 -d | nc -u -w ${RCON_WAIT_SECONDS} 127.0.0.1 ${FIVEM_CONTAINER_PORT} | base64`
    ].join("\n");
    const result = await withTimeout(
        container.run(["sh", "-c", script]),
        COMMAND_TIMEOUT_MS,
        "The server did not answer in time"
    );
    if (result.code === NO_UDP_CLIENT) {
        throw new Error("This server's image has no way for Polaris to reach its console. Redeploy it to get the current one.");
    }
    if (result.code !== 0) throw new Error("The server is not accepting commands yet");
    const raw = Buffer.from(result.output.replace(/\s+/g, ""), "base64");
    // Nothing at all came back, which is a server that is not listening - a command
    // that simply printed nothing still arrives as an empty reply with a header on
    // it.
    if (raw.length === 0) throw new Error("The server is not accepting commands yet");
    const said = parseRconReply(raw);
    if (isRconRefusal(said)) {
        throw new Error("The server did not accept Polaris' console password. Set it again from the Access screen.");
    }
    return said;
}

/**
 * The console password this server runs on.
 *
 * Decrypted from the deploy's own environment, where the install put it and where
 * the image read it from when it wrote the server's config on its first start.
 * The two are kept in step by whatever changes it, so this is the one place that
 * has to be asked.
 */
async function consolePassword(applicationId: string, ownerId: string): Promise<string> {
    const row = await prisma.envVar.findFirst({
        where: { scopeType: "application", scopeId: applicationId, key: RCON_PASSWORD_VAR },
        select: { id: true }
    });
    if (!row) throw new Error("This server has no console password yet");
    // Imported lazily so only the paths that genuinely need it ever touch the
    // master key, and so this reuses the same owner-gated decrypt the env screen
    // does.
    const { revealEnvVar } = await import("@/lib/env-var-service");
    const password = await revealEnvVar(row.id, ownerId).catch(() => null);
    if (!password) throw new Error("This server's console password could not be read");
    return password;
}

/** Where the console password lives on the deploy. The image reads it under this
 *  name when it writes the server's first config. */
export const RCON_PASSWORD_VAR = "RCON_PASSWORD";
