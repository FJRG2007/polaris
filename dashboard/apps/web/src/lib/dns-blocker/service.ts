/**
 * The network filter: its settings, turning it on and off, and where it
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
import { isPortTaken } from "@polaris/deploy";
import { ENV_VALUE_MAX } from "@polaris/core";
import { boundSource, dnsPublishSpec } from "./publish";
import { getHostLanIp } from "@/lib/host-address";
import { setEnvVar } from "@/lib/env-var-service";
import { deployApplication } from "@/lib/deploy-service";
import { createVolume } from "@/lib/deploy-volume-service";
import { QUERY_LOG_DIR } from "./query-log";
import { encodeBlockyConfig, ruleFiles } from "./render";
import { forgetEngineFiles, writeEngineFiles } from "./engine-files";
import { DNS_CHECK_NAME } from "./settings";
import { clockChangeDecision } from "./clock-change";
import { resolveServiceNames } from "./services-registry";
import { installApp, uninstallApp } from "@/lib/apps/install-service";
import { answerBlocks, probeDns, tcpListening, type DnsProbeAnswer } from "./probe";
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
/** The reputation pass's place in the query log. */
const CURSOR_KEY = "dnsLogCursor";

/** Why something the operator asked for was not done, as a key the screen says
 *  in their language (`dnsBlocker` `errors.<code>`). */
export type DnsRefusalCode =
    | "notInstalled"
    | "tooLarge"
    | "noAddress"
    | "portTaken"
    | "portBusy"
    | "notApplied"
    | "notRunning"
    | "notAnswering"
    | "servicesOffline"
    | "servicesMissing";

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
    /** The DNS server runs another configuration than these settings render to
     *  now: saved while it could not take them, rendered differently by a newer
     *  Polaris, or with schedules a daylight-saving change has since moved. */
    readonly stale: boolean;
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
export async function engineConfigCurrent(
    engine: EngineRow,
    known?: DnsSettings
): Promise<boolean> {
    if (!engine.applicationId) return false;
    const [settings, stored] = await Promise.all([
        known ?? readSettings(),
        prisma.envVar.findFirst({
            where: { scopeType: "application", scopeId: engine.applicationId, key: DNS_CONFIG_ENV },
            select: { value: true }
        })
    ]);
    return stored?.value === encodeBlockyConfig(settings);
}

/** Where the reputation pass stopped reading the query log, or null. Kept in
 *  the app's own config beside the settings, which nothing on screen edits. */
export async function readLogCursor(): Promise<unknown> {
    const row = await requireApp();
    return readInstallConfig(row.config)[CURSOR_KEY] ?? null;
}

export async function saveLogCursor(cursor: unknown): Promise<void> {
    const row = await requireApp();
    await patchInstallConfig(row.id, { [CURSOR_KEY]: cursor });
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
    const [answer, deployFailed, current] = await Promise.all([
        address
            ? probeDns(address, DNS_CHECK_NAME)
            : Promise.resolve<DnsProbeAnswer>({ kind: "silent" }),
        engine ? lastDeployFailed(engine) : Promise.resolve(false),
        engine?.applicationId ? engineConfigCurrent(engine, settings) : Promise.resolve(true)
    ]);
    return {
        state: stateOf({ address, engine: Boolean(engine), deployFailed, answer }),
        address,
        settings,
        stale: !current
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The engine's query log on a volume of its own, so the history survives the
 * redeploy every saved setting is. An engine installed before this had none;
 * it gets one the next time it deploys. Idempotent.
 */
async function ensureLogVolume(engine: EngineRow): Promise<void> {
    if (!engine.applicationId) return;
    const held = await prisma.volume.findFirst({
        where: { applicationId: engine.applicationId, mountPath: QUERY_LOG_DIR },
        select: { id: true }
    });
    if (held) return;
    await createVolume(engine.ownerId, {
        applicationId: engine.applicationId,
        name: "query-log",
        mountPath: QUERY_LOG_DIR,
        kind: "volume"
    });
}

/** Write the configuration onto the engine and deploy it again, its ports bound
 *  to this machine's current address when there is one. A failed deploy is
 *  logged and marked on the engine, where the status reads it as `portHeld`,
 *  and refused so the press that asked for it is not answered with success. */
/** Put the rules' files in the DNS server. Never the reason a save fails: the
 *  next save or pass writes them again. */
async function syncRules(settings: DnsSettings): Promise<void> {
    await writeEngineFiles(ruleFiles(settings)).catch((error: unknown) =>
        console.error("polaris: the network filter's rules were not written:", error)
    );
}

async function apply(
    engine: EngineRow,
    encoded: string,
    actorId: string,
    address: string | null,
    settings: DnsSettings
): Promise<void> {
    if (!engine.applicationId) return;
    // Written into the running server first, so a configuration that moves the
    // rules out of itself finds them there the moment it starts: no gap.
    if (engine.status === "running") await syncRules(settings);
    if (address) await bindEngineTo(engine, address);
    await ensureLogVolume(engine).catch((error: unknown) =>
        // History is worth keeping, never worth a resolver that does not start.
        console.error("polaris: could not give the network filter's log a volume:", error)
    );
    await setEnvVar("application", engine.applicationId, engine.ownerId, {
        key: DNS_CONFIG_ENV,
        value: encoded,
        isSecret: false
    });
    try {
        await deployApplication(engine.applicationId, engine.ownerId, actorId);
        // The container may be new: every file again, and the lists loaded.
        forgetEngineFiles();
        await syncRules(settings);
        if (engine.status !== "running") {
            await prisma.installedApp.update({
                where: { id: engine.id },
                data: { status: "running" }
            });
        }
    } catch (error) {
        console.error("polaris: the network filter's DNS server did not deploy:", error);
        await prisma.installedApp.update({ where: { id: engine.id }, data: { status: "failed" } });
        throw new DnsBlockerRefusal(isPortTaken(messageOf(error)) ? "portBusy" : "notApplied");
    }
}

/** The services' names for the settings, or the refusal that says why not. */
async function serviceNamesOrRefuse(
    settings: DnsSettings,
    kept: Record<string, string[]>
): Promise<Record<string, string[]>> {
    const resolved = await resolveServiceNames(settings, kept);
    if ("refusal" in resolved) throw new DnsBlockerRefusal(resolved.refusal);
    return resolved.names;
}

/** Store new settings, and apply them at once when the blocker is on. Refused
 *  with `notApplied` when they were stored but the DNS server did not take them. */
export async function saveSettings(input: unknown, actorId: string): Promise<DnsSettings> {
    const row = await requireApp();
    // The services' names are this path's to write, never the screen's.
    const parsed = readDnsSettings({
        ...dnsSettingsSchema.omit({ serviceDomains: true }).parse(input),
        serviceDomains: {}
    });
    const kept = readDnsSettings(readInstallConfig(row.config)[CONFIG_KEY]).serviceDomains;
    const settings = { ...parsed, serviceDomains: await serviceNamesOrRefuse(parsed, kept) };
    const encoded = encodedConfig(settings);
    await patchInstallConfig(row.id, { [CONFIG_KEY]: settings });
    const engine = await engineRow();
    if (!engine) return settings;
    // A change that leaves the configuration as it is - a rule added or
    // removed - is a file written, never a redeploy, which would leave every
    // device without names while the server comes back.
    if (engine.status === "running" && (await engineConfigCurrent(engine, settings))) {
        await syncRules(settings);
        return settings;
    }
    await apply(engine, encoded, actorId, await getHostLanIp().catch(() => null), settings);
    return settings;
}

/**
 * Port 53 at `address`, asked on both transports before a deploy that would bind
 * it: `portTaken` when another DNS server answers there, `portBusy` when
 * something listens on TCP without being one. Nothing is refused when what
 * answers is the blocker itself.
 */
async function checkPort(address: string): Promise<void> {
    const [answer, listening] = await Promise.all([
        probeDns(address, DNS_CHECK_NAME),
        tcpListening(address)
    ]);
    if (answerBlocks(answer)) return;
    if (answer.kind === "answered") throw new DnsBlockerRefusal("portTaken");
    if (listening) throw new DnsBlockerRefusal("portBusy");
}

/** Bind an existing engine's ports to `address` before it deploys again, which is
 *  what lets an engine installed on every interface recover on Retry. */
async function bindEngineTo(engine: EngineRow, address: string): Promise<void> {
    if (!engine.applicationId) return;
    const app = await prisma.application.findUnique({
        where: { id: engine.applicationId },
        select: { sourceConfig: true }
    });
    const next = app ? boundSource(app.sourceConfig, address) : null;
    if (next === null) return;
    await prisma.application.update({
        where: { id: engine.applicationId },
        data: { sourceConfig: next }
    });
}

/**
 * Start the DNS server on this machine, or deploy it again when it exists - which
 * is also what Retry is. Only ever called from somebody's press.
 *
 * Port 53 is checked first, on both transports, every time the server is not
 * already up: the engine could not bind it, and the operator would be left with
 * a container that fails for a reason it cannot show.
 */
export async function turnOn(actorId: string): Promise<void> {
    const settings = await readSettings();
    const encoded = encodedConfig(settings);
    const address = await getHostLanIp().catch(() => null);
    if (!address) throw new DnsBlockerRefusal("noAddress");
    const engine = await engineRow();
    if (engine) {
        // A running engine holds port 53 itself; only a failed one is checked.
        if (await lastDeployFailed(engine)) await checkPort(address);
        await apply(engine, encoded, actorId, address, settings);
        return;
    }
    await checkPort(address);
    try {
        await installApp(
            actorId,
            actorId,
            {
                catalogId: DNS_ENGINE_APP,
                name: "Network filter DNS server", // i18n-ignore
                serverId: "local",
                storage: [],
                env: []
            },
            dnsPublishSpec(address),
            // Seeded rather than passed as a form value: the configuration is
            // longer than any value a form may send.
            {
                installedAppId: randomUUID(),
                env: [{ key: DNS_CONFIG_ENV, value: encoded, isSecret: false }]
            }
        );
    } catch (error) {
        if (isPortTaken(messageOf(error))) throw new DnsBlockerRefusal("portBusy");
        throw error;
    }
}

/** Stop and remove the DNS server. The settings stay on the app. */
export async function turnOff(): Promise<void> {
    const engine = await engineRow();
    if (!engine) return;
    await uninstallApp(engine.ownerId, engine.id, { deleteData: true });
}

/**
 * Give the DNS server its configuration again when the only thing that moved is
 * the clock: a daylight-saving change shifts every schedule's UTC hours, and the
 * engine would run an hour off until somebody pressed Apply now. Run on a
 * schedule (`dns-blocker-clock`); nothing at all when the blocker is not
 * installed, is off, is not up, or already runs what the settings render to.
 * Whether to is `clockChangeDecision`'s; every other cause of a stale
 * configuration is left to the screen.
 */
export async function reapplyAfterClockChange(
    now: Date = new Date()
): Promise<{ applied: boolean }> {
    const row = await appRow();
    if (!row) return { applied: false };
    const engine = await engineRow();
    const applicationId = engine?.applicationId;
    if (!engine || !applicationId) return { applied: false };
    const settings = readDnsSettings(readInstallConfig(row.config)[CONFIG_KEY]);
    const storedValue = () =>
        prisma.envVar.findFirst({
            where: { scopeType: "application", scopeId: applicationId, key: DNS_CONFIG_ENV },
            select: { value: true }
        });
    const [stored, deployFailed] = await Promise.all([storedValue(), lastDeployFailed(engine)]);
    const decision = clockChangeDecision({
        engine: { running: engine.status === "running" && !deployFailed },
        stored: stored?.value ?? null,
        settings,
        now
    });
    if (!decision.apply || decision.encoded.length > ENV_VALUE_MAX) return { applied: false };
    // A save that landed while this was deciding applies itself; this one must
    // not then write the settings it read over the operator's.
    const [again, storedAgain] = await Promise.all([appRow(), storedValue()]);
    if (again?.config !== row.config || storedAgain?.value !== stored?.value)
        return { applied: false };
    console.info(
        `polaris: the network filter's schedules moved with the clock in ${settings.timeZone}; applying them again`
    );
    await apply(
        engine,
        decision.encoded,
        engine.ownerId,
        await getHostLanIp().catch(() => null),
        settings
    );
    return { applied: true };
}
