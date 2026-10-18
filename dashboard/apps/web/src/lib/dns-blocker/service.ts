/**
 * The network ad blocker: its settings, turning it on and off, and where it
 * stands.
 *
 * Two installs. The `dns-blocker` app is the screen and holds the settings (as
 * JSON on its own install row, key `dns`), and runs nothing. The engine
 * (`dns-blocker-engine`) is a container on this machine answering port 53, and
 * exists only between somebody pressing Turn on and Turn off - never because of
 * an install, an update or a boot. Its whole configuration is one environment
 * value, rendered from the settings, so applying a change is writing that value
 * and deploying again.
 *
 * Where it stands is asked of port 53 itself rather than read from Polaris's own
 * records, because the question the operator has is whether this machine is
 * answering DNS and blocking, and only the port knows.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { randomUUID } from "node:crypto";
import { ENV_VALUE_MAX } from "@polaris/core";
import { getHostLanIp } from "@/lib/host-address";
import { setEnvVar } from "@/lib/env-var-service";
import { deployApplication } from "@/lib/deploy-service";
import { DNS_CHECK_NAME, encodeBlockyConfig } from "./render";
import { installApp, uninstallApp } from "@/lib/apps/install-service";
import { answerBlocks, probeDns, type DnsProbeAnswer } from "./probe";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import {
    DNS_BLOCKER_APP,
    DNS_ENGINE_APP,
    dnsSettingsSchema,
    readDnsSettings,
    type DnsSettings
} from "./settings";

/** The environment value the engine's entrypoint writes its configuration from. */
export const DNS_CONFIG_ENV = "BLOCKY_CONFIG_BASE64";
/** The key the settings live under on the app's install row. */
const CONFIG_KEY = "dns";
const DNS_PORT = 53;

/** Why something the operator asked for was not done, as a key the screen says
 *  in their language (`dnsBlocker` `errors.<code>`). */
export type DnsRefusalCode =
    | "notInstalled"
    | "tooLarge"
    | "noAddress"
    | "portTaken"
    | "notApplied"
    | "notRunning"
    | "notAnswering";

export class DnsBlockerRefusal extends Error {
    constructor(readonly code: DnsRefusalCode) {
        super(code);
        this.name = "DnsBlockerRefusal";
    }
}

/**
 * Where the blocker stands, as the screen explains it.
 *
 * - `off`: no engine, and nothing else answers on port 53.
 * - `portTaken`: no engine, and another DNS server already answers on port 53
 *   of this machine - turning on would fail.
 * - `starting`: the engine exists and is coming up.
 * - `portHeld`: the engine's last deploy failed and nothing answers. Most often
 *   port 53 is held by something that does not answer the network (on Linux,
 *   the machine's own resolver listening for itself), but a failed image pull
 *   reads the same.
 * - `conflict`: the engine exists, and what answers port 53 is not it.
 * - `blocking`: the engine answers, and blocks.
 * - `noAddress`: this machine has no address on the network Polaris knows of.
 */
export type DnsBlockerState =
    "off" | "portTaken" | "starting" | "portHeld" | "conflict" | "blocking" | "noAddress";

export interface DnsBlockerStatus {
    readonly state: DnsBlockerState;
    /** The address devices are told to use as their DNS server. */
    readonly address: string | null;
    readonly settings: DnsSettings;
}

interface EngineRow {
    readonly id: string;
    readonly ownerId: string;
    readonly applicationId: string | null;
    readonly status: string;
}

async function appRow(): Promise<{ id: string; config: string | null } | null> {
    return prisma.installedApp.findFirst({
        where: { catalogId: DNS_BLOCKER_APP, status: { not: "removed" } },
        select: { id: true, config: true },
        orderBy: { createdAt: "asc" }
    });
}

export async function engineRow(): Promise<EngineRow | null> {
    return prisma.installedApp.findFirst({
        where: { catalogId: DNS_ENGINE_APP, status: { not: "removed" } },
        select: { id: true, ownerId: true, applicationId: true, status: true },
        orderBy: { createdAt: "asc" }
    });
}

async function requireApp(): Promise<{ id: string; config: string | null }> {
    const row = await appRow();
    if (!row) throw new DnsBlockerRefusal("notInstalled");
    return row;
}

/** The engine's configuration, or a refusal when it would not fit the one
 *  environment value it travels in. */
export function encodedConfig(settings: DnsSettings): string {
    const encoded = encodeBlockyConfig(settings);
    if (encoded.length > ENV_VALUE_MAX) throw new DnsBlockerRefusal("tooLarge");
    return encoded;
}

/** Whether the engine was last given the configuration the stored settings
 *  render to now. False for an engine deployed before a change to what is
 *  rendered, which keeps running the old one until it is applied again. */
export async function engineConfigCurrent(engine: EngineRow): Promise<boolean> {
    if (!engine.applicationId) return false;
    const [settings, stored] = await Promise.all([
        readSettings(),
        prisma.envVar.findFirst({
            where: { scopeType: "application", scopeId: engine.applicationId, key: DNS_CONFIG_ENV },
            select: { value: true }
        })
    ]);
    return stored?.value === encodeBlockyConfig(settings);
}

/** The settings as stored, whole whatever was stored. */
export async function readSettings(): Promise<DnsSettings> {
    const row = await requireApp();
    return readDnsSettings(readInstallConfig(row.config)[CONFIG_KEY]);
}

/** Whether the last deploy of the engine failed. */
async function lastDeployFailed(engine: EngineRow): Promise<boolean> {
    if (engine.status === "failed") return true;
    if (!engine.applicationId) return false;
    const last = await prisma.deployment.findFirst({
        where: { deployableType: "application", deployableId: engine.applicationId },
        select: { status: true },
        orderBy: { createdAt: "desc" }
    });
    return last?.status === "failed";
}

/** The state, from what answered port 53. Pure; exported for tests. */
export function stateOf(input: {
    readonly address: string | null;
    readonly engine: boolean;
    readonly deployFailed: boolean;
    readonly answer: DnsProbeAnswer;
}): DnsBlockerState {
    if (!input.address) return "noAddress";
    if (!input.engine) return input.answer.kind === "answered" ? "portTaken" : "off";
    if (answerBlocks(input.answer)) return "blocking";
    if (input.answer.kind === "answered") return "conflict";
    return input.deployFailed ? "portHeld" : "starting";
}

export async function dnsBlockerStatus(): Promise<DnsBlockerStatus> {
    const [settings, engine, address] = await Promise.all([
        readSettings(),
        engineRow(),
        getHostLanIp().catch(() => null)
    ]);
    const [answer, deployFailed] = await Promise.all([
        address
            ? probeDns(address, DNS_CHECK_NAME)
            : Promise.resolve<DnsProbeAnswer>({ kind: "silent" }),
        engine ? lastDeployFailed(engine) : Promise.resolve(false)
    ]);
    return {
        state: stateOf({ address, engine: Boolean(engine), deployFailed, answer }),
        address,
        settings
    };
}

/** Write the configuration onto the engine and deploy it again. A failed deploy
 *  is logged and marked on the engine, where the status reads it as `portHeld`,
 *  and refused so the press that asked for it is not answered with success. */
async function apply(engine: EngineRow, encoded: string, actorId: string): Promise<void> {
    if (!engine.applicationId) return;
    await setEnvVar("application", engine.applicationId, engine.ownerId, {
        key: DNS_CONFIG_ENV,
        value: encoded,
        isSecret: false
    });
    try {
        await deployApplication(engine.applicationId, engine.ownerId, actorId);
        if (engine.status !== "running") {
            await prisma.installedApp.update({
                where: { id: engine.id },
                data: { status: "running" }
            });
        }
    } catch (error) {
        console.error("polaris: the ad blocker's DNS server did not deploy:", error);
        await prisma.installedApp.update({ where: { id: engine.id }, data: { status: "failed" } });
        throw new DnsBlockerRefusal("notApplied");
    }
}

/** Store new settings, and apply them at once when the blocker is on. Refused
 *  with `notApplied` when they were stored but the DNS server did not take them. */
export async function saveSettings(input: unknown, actorId: string): Promise<DnsSettings> {
    const row = await requireApp();
    const settings = readDnsSettings(dnsSettingsSchema.parse(input));
    const encoded = encodedConfig(settings);
    await patchInstallConfig(row.id, { [CONFIG_KEY]: settings });
    const engine = await engineRow();
    if (engine) await apply(engine, encoded, actorId);
    return settings;
}

/**
 * Start the DNS server on this machine, or deploy it again when it exists - which
 * is also what Retry is. Only ever called from somebody's press.
 *
 * Refused before anything is created when another DNS server already answers on
 * port 53 here: the engine could not bind it, and the operator would be left with
 * a container that fails for a reason it cannot show.
 */
export async function turnOn(actorId: string): Promise<void> {
    const settings = await readSettings();
    const encoded = encodedConfig(settings);
    const address = await getHostLanIp().catch(() => null);
    if (!address) throw new DnsBlockerRefusal("noAddress");
    const engine = await engineRow();
    if (engine) {
        await apply(engine, encoded, actorId);
        return;
    }
    const answer = await probeDns(address, DNS_CHECK_NAME);
    if (answer.kind === "answered" && !answerBlocks(answer))
        throw new DnsBlockerRefusal("portTaken");
    await installApp(
        actorId,
        actorId,
        {
            catalogId: DNS_ENGINE_APP,
            name: "Ad blocker DNS server", // i18n-ignore
            serverId: "local",
            storage: [],
            env: []
        },
        // Exactly 53, on both transports: a router can only be pointed at an
        // address, never a port, and DNS falls back to TCP for long answers.
        {
            primary: { host: DNS_PORT, container: DNS_PORT, protocol: "udp" },
            extra: [{ host: DNS_PORT, container: DNS_PORT, protocol: "tcp" }]
        },
        // Seeded rather than passed as a form value: the configuration is longer
        // than any value a form may send.
        {
            installedAppId: randomUUID(),
            env: [{ key: DNS_CONFIG_ENV, value: encoded, isSecret: false }]
        }
    );
}

/** Stop and remove the DNS server. The settings stay on the app. */
export async function turnOff(): Promise<void> {
    const engine = await engineRow();
    if (!engine) return;
    await uninstallApp(engine.ownerId, engine.id, { deleteData: true });
}
