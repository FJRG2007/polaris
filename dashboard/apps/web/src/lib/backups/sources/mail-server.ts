/**
 * A mail server, backed up with its engine's own export.
 *
 * Copying the engine's volumes while it runs catches its store mid-write: every
 * delivery, every flag change, the queue, all being written as the files are read.
 * The engine has an export of its own for exactly this, and it is only safe with
 * the server stopped (stalw.art/docs/management/maintenance/migration). So a copy
 * is: stop the engine, run the same image once against the same volumes with
 * `--export`, start the engine again, and archive what the export wrote. Mail is
 * refused for as long as the export takes - senders retry, and nothing is lost.
 *
 * Putting one back is the mirror: the engine stopped, the store it had moved aside,
 * `--import` of the export into an empty one, and the old store put back if the
 * import fails. A copy of the server as it was is taken first, like before any
 * restore that replaces a database's contents.
 *
 * The image's program is `/usr/local/bin/stalwart`, started with
 * `--config /etc/stalwart/config.json` (its Dockerfile's ENTRYPOINT and CMD, v0.16),
 * and it is a Debian image, so a script can run beside it for the restore.
 */

import { join } from "node:path";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { Readable } from "node:stream";
import { buildSelector } from "../schemas";
import { createWriteStream } from "node:fs";
import { writeThroughShell } from "./files";
import { pipeline } from "node:stream/promises";
import { currentReleaseRef } from "@/lib/deploy/releases";
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
import { parseContainerState, shortHash, type RuntimePorts } from "@polaris/deploy";
import {
    SourceUnavailableError,
    shellQuote,
    stageDir,
    stagedFrom,
    stamp,
    type BackupSource,
    type DiscoveredTarget,
    type SourceResource,
    type StagedArtifact
} from "./types";

const PROGRAM = "/usr/local/bin/stalwart";
const CONFIG_FILE = `${core.STALWART_CONFIG_PATH}/config.json`;
/** Where the export is written and read back from: beside the store, on its volume. */
const EXPORT_DIR = `${core.STALWART_DATA_PATH}/.polaris-export`;
const IMPORT_DIR = `${core.STALWART_DATA_PATH}/.polaris-import`;
const ASIDE_DIR = ".polaris-before-restore";
/** How long an export or an import may run before it is given up on. */
const MAINTENANCE_LIMIT_MS = 2 * 60 * 60_000;
const POLL_MS = 3_000;

/** What names the copy's format, so a restore refuses anything else. */
export const MAIL_EXPORT_FORMAT = "stalwart-export";

interface Engine {
    readonly serverId: string;
    readonly hostname: string;
    readonly container: string;
    readonly image: string;
    readonly configVolume: string;
    readonly dataVolume: string;
    readonly ports: RuntimePorts;
}

/** The volume mounted at `path` in an inspected container, by its Docker name. */
export function volumeAt(inspect: unknown, path: string): string | null {
    const mounts = (inspect as { Mounts?: unknown } | null)?.Mounts;
    if (!Array.isArray(mounts)) return null;
    for (const mount of mounts) {
        const entry = mount as { Type?: unknown; Name?: unknown; Destination?: unknown };
        if (entry.Type === "volume" && entry.Destination === path && typeof entry.Name === "string") return entry.Name;
    }
    return null;
}

function serverIdOf(resource: SourceResource): string {
    const id = resource.selector.split(":")[1];
    if (!id) throw new SourceUnavailableError("This mail server's id is missing from its record");
    return id;
}

/** Everything the export and the import need to reach the engine. */
async function engineOf(serverId: string): Promise<Engine> {
    const server = await prisma.mailServer.findUnique({ where: { id: serverId } });
    if (!server) throw new SourceUnavailableError("That mail server no longer exists");
    if (!server.applicationId) throw new SourceUnavailableError("That mail server has not finished setting up");
    const app = await prisma.application.findUnique({
        where: { id: server.applicationId },
        include: { environment: { include: { project: true } }, target: true }
    });
    if (!app?.currentDeploymentId) throw new SourceUnavailableError("That mail server's engine is not running");
    const container = (await currentReleaseRef(app)).name;
    const ports = await getPorts(app.target as TargetRow, app.environment.project.ownerId);
    try {
        const inspect = await ports.inspect(container);
        const image = (inspect as { Config?: { Image?: unknown } } | null)?.Config?.Image;
        const configVolume = volumeAt(inspect, core.STALWART_CONFIG_PATH);
        const dataVolume = volumeAt(inspect, core.STALWART_DATA_PATH);
        if (typeof image !== "string" || !configVolume || !dataVolume) {
            throw new SourceUnavailableError("The engine's volumes could not be found on its machine");
        }
        return { serverId, hostname: server.hostname, container, image, configVolume, dataVolume, ports };
    } catch (error) {
        await ports.dispose().catch(() => undefined);
        throw error;
    }
}

/** The one-off container that runs the engine's program with the engine stopped. */
export function maintenanceSpec(
    engine: Pick<Engine, "serverId" | "image" | "configVolume" | "dataVolume">,
    run: { entrypoint?: string[]; command: string[] }
): import("@polaris/deploy").ComposeSpec {
    const name = `polaris-mailtask-${shortHash(engine.serverId, 8)}`;
    return {
        project: name,
        services: [
            {
                name,
                image: engine.image,
                ...(run.entrypoint ? { entrypoint: run.entrypoint } : {}),
                command: run.command,
                env: {},
                ports: [],
                volumes: [
                    { source: engine.configVolume, target: core.STALWART_CONFIG_PATH, kind: "volume" },
                    { source: engine.dataVolume, target: core.STALWART_DATA_PATH, kind: "volume" }
                ],
                labels: {},
                networks: [],
                restart: "no"
            }
        ],
        volumes: [],
        networks: [],
        externalVolumes: [engine.configVolume, engine.dataVolume]
    };
}

/** The last lines a finished maintenance container printed, for the reason. */
async function lastWords(ports: RuntimePorts, container: string): Promise<string> {
    const parts: Buffer[] = [];
    await ports.logs(container, (chunk) => void parts.push(Buffer.from(chunk)), { tail: 20 }).catch(() => undefined);
    return Buffer.concat(parts).toString("utf8").trim().slice(-600);
}

/**
 * Run the engine's program once, with the engine stopped, and start the engine
 * again whatever happened. Throws with what the program printed when it fails.
 */
async function withEngineStopped(engine: Engine, run: { entrypoint?: string[]; command: string[] }, what: string): Promise<void> {
    const spec = maintenanceSpec(engine, run);
    const task = spec.services[0]!.name;
    await engine.ports.container(engine.container, "stop");
    try {
        await engine.ports.composeDown(spec.project).catch(() => undefined);
        await engine.ports.composeUp(spec);
        const deadline = Date.now() + MAINTENANCE_LIMIT_MS;
        for (;;) {
            const state = parseContainerState(await engine.ports.inspect(task).catch(() => null));
            if (state.status === "exited" || state.status === "dead") {
                if (state.exitCode === 0) return;
                const said = await lastWords(engine.ports, task);
                throw new SourceUnavailableError(`The ${what} failed${said ? `: ${said}` : ""}`);
            }
            if (Date.now() > deadline) throw new SourceUnavailableError(`The ${what} did not finish in two hours`);
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
    } finally {
        await engine.ports.composeDown(spec.project).catch(() => undefined);
        await engine.ports.container(engine.container, "start");
    }
}

/**
 * The restore script: the store moved aside, the export imported into an empty
 * one, the old store back if that fails - and removed once it did not, since the
 * copy taken just before the restore is the way back.
 */
export function restoreScript(): string {
    const others = `find . -mindepth 1 -maxdepth 1 ! -name .polaris-import ! -name ${ASIDE_DIR}`;
    return [
        "set -eu",
        `cd ${shellQuote(core.STALWART_DATA_PATH)}`,
        `rm -rf ${ASIDE_DIR}`,
        `mkdir ${ASIDE_DIR}`,
        `${others} -exec mv -t ${ASIDE_DIR} -- {} +`,
        `if ${PROGRAM} --config ${shellQuote(CONFIG_FILE)} --import ${shellQuote(IMPORT_DIR)}; then rm -rf ${ASIDE_DIR}; exit 0; fi`,
        `${others} -exec rm -rf -- {} +`,
        `find ${ASIDE_DIR} -mindepth 1 -maxdepth 1 -exec mv -t . -- {} +`,
        `rmdir ${ASIDE_DIR}`,
        "exit 1"
    ].join("\n");
}

export const mailServerSource: BackupSource = {
    kind: "mail-server",

    async discover(ownerId: string): Promise<DiscoveredTarget[]> {
        const rows = await prisma.mailServer.findMany({
            where: { ownerId, applicationId: { not: null } },
            select: { id: true, hostname: true, primaryDomain: true },
            take: 100
        });
        return rows.map((row) => ({
            kind: "mail-server" as const,
            selector: buildSelector("mail-server", [row.id]),
            name: `Mail ${row.hostname}`,
            context: row.primaryDomain,
            target: { kind: "mail-server", serverId: row.id }
        }));
    },

    async resolveName(resource: SourceResource): Promise<string | null> {
        const row = await prisma.mailServer.findUnique({
            where: { id: serverIdOf(resource) },
            select: { hostname: true }
        });
        return row ? `Mail ${row.hostname}` : null;
    },

    async produce(resource: SourceResource): Promise<StagedArtifact> {
        const engine = await engineOf(serverIdOf(resource));
        const at = new Date();
        const inContainer = `/tmp/polaris-mail-export-${stamp(at)}.tar.gz`;
        try {
            // A leftover from a run that died is removed while the engine can
            // still do it, so the archive holds this export and nothing older.
            const cleared = await engine.ports.runIn(engine.container, [
                "sh",
                "-c",
                `rm -rf ${shellQuote(EXPORT_DIR)} && mkdir -p ${shellQuote(EXPORT_DIR)}`
            ]);
            if (cleared.code !== 0) {
                throw new SourceUnavailableError(`Preparing the export failed: ${cleared.output.trim().slice(0, 300)}`);
            }
            await withEngineStopped(
                engine,
                { command: ["--config", CONFIG_FILE, "--export", EXPORT_DIR] },
                "engine's export"
            );
            const tarred = await engine.ports.runIn(engine.container, [
                "sh",
                "-c",
                `tar -czf ${shellQuote(inContainer)} -C ${shellQuote(EXPORT_DIR)} .`
            ]);
            if (tarred.code !== 0) {
                throw new SourceUnavailableError(
                    `Archiving the export failed: ${tarred.output.trim().slice(0, 400) || `exit ${tarred.code}`}`
                );
            }
            const dir = await stageDir();
            const fileName = `mail-${engine.hostname.replace(/[^a-z0-9.-]/gi, "-")}-${stamp(at)}.tar.gz`;
            const target = join(dir, fileName);
            const bytes = await engine.ports.readFile(engine.container, inContainer);
            await pipeline(Readable.fromWeb(bytes as import("node:stream/web").ReadableStream), createWriteStream(target));
            return stagedFrom(dir, target, fileName, {
                format: MAIL_EXPORT_FORMAT,
                image: engine.image,
                takenAt: at.toISOString()
            });
        } finally {
            await engine.ports
                .runIn(engine.container, ["rm", "-rf", "--", EXPORT_DIR, inContainer])
                .catch(() => undefined);
            await engine.ports.dispose().catch(() => undefined);
        }
    },

    async restore(resource: SourceResource, body: ReadableStream<Uint8Array>, metadata: Record<string, unknown>) {
        if (metadata.format !== MAIL_EXPORT_FORMAT) {
            throw new SourceUnavailableError("That copy is not an export of this mail server");
        }
        // The way back if this goes wrong: the server as it is now, taken the
        // same consistent way. Imported late - the engine imports the sources.
        const { runBackup } = await import("../service");
        const safety = await runBackup(resource.id, { trigger: "pre-restore" });
        if (safety.status === "failed") {
            throw new SourceUnavailableError("A copy of the server as it is now could not be taken, so nothing was restored");
        }

        const engine = await engineOf(serverIdOf(resource));
        const inContainer = `/tmp/polaris-mail-import-${stamp(new Date())}.tar.gz`;
        try {
            const bytes = Buffer.from(await new Response(body).arrayBuffer());
            if (engine.ports.writeFile) {
                await engine.ports.writeFile(engine.container, inContainer, Readable.from([bytes]), bytes.length);
            } else {
                await writeThroughShell(engine.ports, engine.container, inContainer, bytes);
            }
            const unpacked = await engine.ports.runIn(engine.container, [
                "sh",
                "-c",
                `rm -rf ${shellQuote(IMPORT_DIR)} && mkdir -p ${shellQuote(IMPORT_DIR)} && tar -xzf ${shellQuote(inContainer)} -C ${shellQuote(IMPORT_DIR)}`
            ]);
            if (unpacked.code !== 0) {
                throw new SourceUnavailableError(`Unpacking the export failed: ${unpacked.output.trim().slice(0, 400)}`);
            }
            await withEngineStopped(
                engine,
                { entrypoint: ["/bin/sh", "-c"], command: [restoreScript()] },
                "engine's import"
            );
        } finally {
            await engine.ports
                .runIn(engine.container, ["rm", "-rf", "--", IMPORT_DIR, inContainer])
                .catch(() => undefined);
            await engine.ports.dispose().catch(() => undefined);
        }
    }
};
