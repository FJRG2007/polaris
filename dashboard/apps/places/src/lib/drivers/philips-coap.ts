/**
 * Philips air purifiers and humidifiers on the same network, as devices - the
 * units the Philips Air+ app drives.
 *
 * Local, like Home Assistant's Philips integration (ruaan-deysel/
 * ha-philips-airpurifier) and over the same protocol (`integrations/
 * philips-api.ts`): no account, no cloud - Philips' cloud API is not public -
 * and nothing that stops working when Philips' servers do. What each model can
 * do is that integration's own table (`integrations/philips-models.ts`).
 *
 * One connection is the units it found. Left without an address it looks
 * through this server's /24 for anything answering Philips' identity resource;
 * given an address it asks that one. Nothing is paired and no key is kept: the
 * protocol's only secret is in every copy of the app, so what is stored is where
 * each unit is and which model it is.
 *
 * Two firmware faults shape the rest, both known from that integration:
 *
 * - A unit's CoAP wedges now and then and only a fresh sync wakes it. Every
 *   read is its own sync on a fresh link, retried once on a new one; a unit that
 *   still does not answer is drawn as not answering and left alone for a while
 *   that doubles up to a minute (`RECONNECT_INITIAL_DELAY`/`_MAX_DELAY`), rather
 *   than asked again on every sync while it is wedged.
 * - Some firmware never answers a status read and only pushes one on a change
 *   (`status_nudge`), to a single client. For those a link is held open,
 *   observing, and their pushes are what is read; it is opened by writing one
 *   value and putting it back (the display light, ending where the owner left
 *   it), and opened again when nothing has been pushed for half an hour
 *   (`NUDGE_WATCHDOG_TIMEOUT`). Commands to them travel on that same link, since
 *   a second client would evict the first.
 *
 * Newer firmware on some models switches local control off altogether. Such a
 * unit answers "port unreachable", or answers who it is and nothing else; either
 * way it is said in those words rather than as a unit that is not there.
 *
 * Server-only.
 */

import { z } from "zod";
import { HomeError } from "../home-error";
import * as philips from "../integrations/philips-api";
import { forbiddenAddress } from "../integrations/lan-address";
import { subnetTargets, unitAddressOf } from "../integrations/lan-unit";
import {
    PHILIPS_CHILD_LOCKS,
    PHILIPS_HUMIDIFIERS,
    PHILIPS_LIGHTS,
    PHILIPS_MODELS,
    type PhilipsModel,
    type Value
} from "../integrations/philips-models";
import * as kinds from "../device-kinds";
import { DriverError, type Credentials, type DeviceDriver, type DeviceSnapshot } from "./contract";

export const PHILIPS_COAP = "philips-coap";

type Status = philips.PhilipsStatus;

// --- what a status says (const.py `PhilipsApi`, helpers.py) --------------------

const NAME_KEYS = ["name", "D01-03", "D01S03"];
const MODEL_KEYS = ["modelid", "D01-05", "D01S05"];
const FIRMWARE_KEYS = ["swversion", "D01-21", "D01S12"];

/** `ApiGeneration` power keys and their on and off values (`DeviceModelConfig`). */
const POWER: Readonly<Record<PhilipsModel["generation"], { key: string; on: Value; off: Value }>> =
    {
        gen1: { key: "pwr", on: "1", off: "0" },
        gen2: { key: "D03-02", on: "ON", off: "OFF" },
        gen3: { key: "D03102", on: 1, off: 0 }
    };

/** `SENSOR_TYPES`, the measures Places draws, and how each value reads. */
const SENSORS: readonly {
    key: string;
    measure: keyof kinds.AirSettings["readings"];
    scale?: number;
}[] = [
    { key: "pm25", measure: "pm25" },
    { key: "D03-33", measure: "pm25" },
    { key: "D03221", measure: "pm25" },
    { key: "iaql", measure: "allergen" },
    { key: "D03-32", measure: "allergen" },
    { key: "D03120", measure: "allergen" },
    { key: "rh", measure: "humidity" },
    { key: "D03125", measure: "humidity" },
    { key: "temp", measure: "temperature" },
    // `_to_celsius_from_tenths`.
    { key: "D03224", measure: "temperature", scale: 0.1 }
];

/** `FILTER_TYPES`: where each filter's hours left are, and its total. The
 *  NanoProtect pre-filter is labelled a pre-filter there too. */
const FILTERS: readonly { key: string; total: string; kind: kinds.AirFilter }[] = [
    { key: "fltsts0", total: "flttotal0", kind: "pre" },
    { key: "fltsts1", total: "flttotal1", kind: "hepa" },
    { key: "fltsts2", total: "flttotal2", kind: "carbon" },
    { key: "wicksts", total: "wicktotal", kind: "wick" },
    { key: "D05-14", total: "D05-08", kind: "nanoprotect" },
    { key: "D05-13", total: "D05-07", kind: "pre" },
    { key: "D0540E", total: "D05408", kind: "nanoprotect" },
    { key: "D0520D", total: "D05207", kind: "pre" }
];

function text(status: Status, keys: readonly string[]): string {
    for (const key of keys) {
        const value = status[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
}

function numberOf(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A key as the wire knows it: `D03105#2` names a value scheme, not a key. */
function bare(key: string): string {
    return key.split("#")[0] ?? key;
}

/** The model id as the integration takes it (`extract_model`): the first nine
 *  characters. */
export function modelIdOf(status: Status): string {
    return text(status, MODEL_KEYS).slice(0, 9);
}

/**
 * A unit's entry in the table, looked up as the config flow does: the model,
 * then the model and the Wi-Fi module's generation, then the family. Null for a
 * model the integration does not list.
 */
export function philipsModelOf(modelId: string, wifiVersion = ""): PhilipsModel | null {
    if (!modelId) return null;
    const long = `${modelId} ${wifiVersion.split("@")[0] ?? ""}`;
    return (
        PHILIPS_MODELS[modelId] ??
        PHILIPS_MODELS[long] ??
        PHILIPS_MODELS[modelId.slice(0, 6)] ??
        null
    );
}

/** The key scheme a status uses, for a model the table does not list. */
function generationOf(status: Status, model: PhilipsModel | null): PhilipsModel["generation"] {
    if (model) return model.generation;
    if ("D03102" in status) return "gen3";
    if ("D03-02" in status) return "gen2";
    return "gen1";
}

/** Whether a status holds every value of a pattern (`PhilipsFan.preset_mode`). */
function holds(status: Status, pattern: Readonly<Record<string, Value>>): boolean {
    return Object.entries(pattern).every(([key, value]) => status[key] === value);
}

function filtersOf(status: Status, model: PhilipsModel | null): kinds.AirFilterReading[] {
    const filters: kinds.AirFilterReading[] = [];
    for (const filter of FILTERS) {
        if (model?.unavailableFilters.includes(filter.key)) continue;
        const left = numberOf(status[filter.key]);
        if (left === null) continue;
        const total = numberOf(status[filter.total]);
        // `PhilipsFilterSensor`: with a total it is a share; without, hours.
        const percent =
            total !== null && total > 0
                ? Math.max(0, Math.min(100, Math.round((100 * left) / total)))
                : null;
        const hours = Math.max(0, left);
        filters.push({
            kind: filter.kind,
            percent,
            hours,
            state: kinds.filterState(percent, hours)
        });
    }
    return filters;
}

/** A unit's status, as Places' settings. */
export function philipsAir(status: Status, model: PhilipsModel | null): kinds.AirSettings {
    const presets = Object.entries(model?.presets ?? {}).filter(
        (entry): entry is [kinds.AirMode, Readonly<Record<string, Value>>] =>
            (kinds.AIR_MODES as readonly string[]).includes(entry[0])
    );
    const speeds = Object.entries(model?.speeds ?? {}).filter(
        (entry): entry is [kinds.AirSpeed, Readonly<Record<string, Value>>] =>
            (kinds.AIR_SPEEDS as readonly string[]).includes(entry[0])
    );

    const options: kinds.AirSettings["options"] = {};
    const lock = model?.switches.find((key) => key in PHILIPS_CHILD_LOCKS);
    if (lock && status[lock] !== undefined)
        options.childLock = status[lock] !== PHILIPS_CHILD_LOCKS[lock]!.off;
    const light = model?.lights[0];
    if (light && status[bare(light)] !== undefined) {
        // `PhilipsLight.is_on`: compared as numbers.
        options.light = Number(status[bare(light)]) !== Number(PHILIPS_LIGHTS[light]!.off);
    }

    let humidity: kinds.AirSettings["humidity"] = null;
    const humidifier = model?.humidifiers[0];
    const spec = humidifier ? PHILIPS_HUMIDIFIERS[humidifier] : undefined;
    if (humidifier && spec) {
        const target = numberOf(status[bare(humidifier)]);
        humidity = {
            target: target === null ? null : Math.max(spec.min, Math.min(spec.max, target)),
            min: spec.min,
            max: spec.max,
            step: spec.step
        };
        // A 2-in-1 unit is switched between purifying and humidifying.
        if (spec.switch && status[spec.function] !== undefined) {
            options.humidify = status[spec.function] === spec.humidifying;
        }
    }

    return {
        mode: presets.find(([, pattern]) => holds(status, pattern))?.[0] ?? null,
        modes: presets.map(([mode]) => mode),
        speed: speeds.find(([, pattern]) => holds(status, pattern))?.[0] ?? null,
        speeds: speeds.map(([speed]) => speed),
        humidity,
        options,
        ...philipsMeasures(status, model)
    };
}

/**
 * What a status measures and how worn its filters are, by the keys Philips
 * uses. The same keys travel over the cloud (`D03221` is PM2.5 there too,
 * `D0540E` the NanoProtect filter's hours), so the cloud driver reads its
 * statuses through this rather than a table of its own.
 */
export function philipsMeasures(
    status: Status,
    model: PhilipsModel | null
): Pick<kinds.AirSettings, "readings" | "filters"> {
    const readings: kinds.AirSettings["readings"] = {};
    for (const sensor of SENSORS) {
        if (
            readings[sensor.measure] !== undefined ||
            model?.unavailableSensors.includes(sensor.key)
        )
            continue;
        const value = numberOf(status[sensor.key]);
        if (value === null) continue;
        const read = sensor.scale ? Math.round(value * sensor.scale * 10) / 10 : value;
        if (sensor.measure === "humidity" && (read < 0 || read > 100)) continue;
        readings[sensor.measure] = read;
    }
    return { readings, filters: filtersOf(status, model) };
}

/** What to write for one action, in the unit's own keys. */
export function philipsValues(
    model: PhilipsModel | null,
    generation: PhilipsModel["generation"],
    action: kinds.DeviceAction,
    command: kinds.DeviceCommand | undefined
): Record<string, Value> {
    const power = POWER[generation];
    if (action === "turn-on") return { [power.key]: power.on };
    if (action === "turn-off") return { [power.key]: power.off };
    const setting = kinds.airCommandOf(command);
    if (!setting || setting.action !== action) throw new HomeError("Say what to set it to");
    switch (setting.action) {
        case "set-mode": {
            const pattern = model?.presets[setting.mode];
            if (!pattern) throw new HomeError("That mode is not one this device has");
            return { ...pattern };
        }
        case "set-fan": {
            const pattern = model?.speeds[setting.speed];
            if (!pattern) throw new HomeError("That fan speed is not one this device has");
            return { ...pattern };
        }
        case "set-humidity": {
            const humidifier = model?.humidifiers[0];
            const spec = humidifier ? PHILIPS_HUMIDIFIERS[humidifier] : undefined;
            if (!humidifier || !spec) throw new HomeError("That device does not humidify");
            // `async_set_humidity`: onto the step, inside the range.
            const target = Math.max(
                spec.min,
                Math.min(spec.max, Math.round(setting.target / spec.step) * spec.step)
            );
            return { [bare(humidifier)]: target };
        }
        case "set-option": {
            if (setting.option === "childLock") {
                const lock = model?.switches.find((key) => key in PHILIPS_CHILD_LOCKS);
                if (!lock) break;
                const values = PHILIPS_CHILD_LOCKS[lock]!;
                return { [lock]: setting.on ? values.on : values.off };
            }
            if (setting.option === "light") {
                const light = model?.lights[0];
                if (!light) break;
                const values = PHILIPS_LIGHTS[light]!;
                return { [bare(light)]: setting.on ? values.on : values.off };
            }
            const humidifier = model?.humidifiers[0];
            const spec = humidifier ? PHILIPS_HUMIDIFIERS[humidifier] : undefined;
            if (!spec?.switch) break;
            // `PhilipsHumidifier.async_set_mode`: on, and the function chosen.
            return {
                [spec.power]: spec.on,
                [spec.function]: setting.on ? spec.humidifying : spec.idle
            };
        }
    }
    throw new HomeError("That setting is not one this device has");
}

// --- the units a connection holds -----------------------------------------------

export const philipsUnitSchema = z.object({
    address: z.string().min(7).max(15),
    /** The unit's own id, from its status; what the row is keyed by. */
    deviceId: z.string().min(1).max(120),
    /** The id its identity resource gives, where it gives one: what finds it
     *  again after it moves. */
    infoId: z.string().max(120),
    model: z.string().max(120),
    wifi: z.string().max(120),
    name: z.string().max(120)
});

export type PhilipsUnit = z.infer<typeof philipsUnitSchema>;

const unitsSchema = z.array(philipsUnitSchema).max(64);

function unitsOf(credentials: Credentials): PhilipsUnit[] {
    let raw: unknown;
    try {
        raw = JSON.parse(credentials.units ?? "");
    } catch {
        raw = null;
    }
    const parsed = unitsSchema.safeParse(raw);
    if (!parsed.success || parsed.data.length === 0) {
        throw new DriverError(
            "Polaris has lost track of these air purifiers. Connect them again.",
            "unauthorized"
        );
    }
    return parsed.data;
}

function modelOfUnit(unit: Pick<PhilipsUnit, "model" | "wifi">): PhilipsModel | null {
    return philipsModelOf(unit.model.slice(0, 9), unit.wifi);
}

/** One unit as a row. */
export function philipsSnapshot(unit: PhilipsUnit, status: Status | null): DeviceSnapshot {
    const name = unit.name || `Philips ${unit.model || unit.deviceId.slice(-4)}`;
    if (!status) {
        return {
            externalId: unit.deviceId,
            kind: "air",
            name,
            model: unit.model || null,
            firmware: null,
            state: "unknown",
            doorState: "none",
            batteryPercent: null,
            batteryCritical: false,
            online: false
        };
    }
    const model = modelOfUnit(unit);
    const power = POWER[generationOf(status, model)];
    const air = philipsAir(status, model);
    const headline = kinds.airHeadline(air);
    const on = status[power.key];
    return {
        externalId: unit.deviceId,
        kind: "air",
        name,
        model: text(status, MODEL_KEYS) || unit.model || null,
        firmware: text(status, FIRMWARE_KEYS) || null,
        state: on === undefined ? "unknown" : on === power.on ? "on" : "off",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        value: headline?.value ?? null,
        unit: headline ? kinds.MEASURE_UNITS[headline.measure] || null : null,
        air
    };
}

// --- keeping in touch -----------------------------------------------------------

/** `RECONNECT_INITIAL_DELAY` and `RECONNECT_MAX_DELAY`. */
const RETRY_INITIAL_MS = 5000;
const RETRY_MAX_MS = 60000;
/** `NUDGE_WATCHDOG_TIMEOUT`: a push-only unit can be idle this long. */
export const PUSH_WATCHDOG_MS = 30 * 60 * 1000;
/** How often a lost unit is looked for on the subnet. */
const LOOK_AGAIN_MS = 5 * 60 * 1000;

/** Per unit, how its reads have been going: the backoff after failures. */
const health = new Map<string, { failures: number; retryAt: number }>();

function failed(address: string): void {
    const seen = health.get(address);
    const failures = (seen?.failures ?? 0) + 1;
    const delay = Math.min(RETRY_INITIAL_MS * 2 ** (failures - 1), RETRY_MAX_MS);
    health.set(address, { failures, retryAt: Date.now() + delay });
}

/**
 * The link held open to a unit that only pushes. One per address per process:
 * the firmware serves one client, so a second link would cut the first.
 */
interface PushWatch {
    status: Status | null;
    /** When the last push arrived. */
    at: number;
    session: philips.PhilipsSession | null;
    token: Buffer | null;
    connecting: Promise<void> | null;
}

const watches = new Map<string, PushWatch>();

/** `_build_status_nudge`: through a transient value, ending where the owner left
 *  the key rather than where the table rests it. */
export function nudgeFor(nudge: PhilipsModel["nudge"], last: Status | null): [string, Value][] {
    if (!nudge || nudge.length === 0) return [];
    const key = bare(nudge[0]![0]);
    let transient: Value = nudge[0]![1];
    let resting: Value = nudge[nudge.length - 1]![1];
    const known = last?.[key];
    if (typeof known === "number" || typeof known === "string" || typeof known === "boolean")
        resting = known;
    if (transient === resting) transient = nudge[nudge.length - 1]![1];
    return [
        [key, transient],
        [key, resting]
    ];
}

function closeWatch(watch: PushWatch): void {
    watch.session?.close();
    watch.session = null;
    watch.token = null;
}

/** Open, or reopen, the observing link of a push-only unit. */
function connectWatch(address: string, model: PhilipsModel, watch: PushWatch): Promise<void> {
    watch.connecting ??= (async () => {
        closeWatch(watch);
        try {
            const opened = await philips.nudgedPhilips(
                address,
                nudgeFor(model.nudge, watch.status)
            );
            watch.session = opened.session;
            watch.token = opened.token;
            watch.status = opened.status;
            watch.at = Date.now();
            health.delete(address);
            opened.session.link.onUnclaimed((message) => {
                if (!watch.token || !message.token.equals(watch.token)) return;
                try {
                    const pushed = philips.reportedOf(message.payload);
                    if (pushed) {
                        watch.status = pushed;
                        watch.at = Date.now();
                    }
                } catch {
                    // A garbled push is skipped; the next one is read.
                }
            });
        } catch (error) {
            failed(address);
            throw error;
        } finally {
            watch.connecting = null;
        }
    })();
    return watch.connecting;
}

/** What a push-only unit last pushed, keeping its link open and reopening it
 *  when it has gone quiet for too long. */
async function readPushed(address: string, model: PhilipsModel): Promise<Status | null> {
    let watch = watches.get(address);
    if (!watch) {
        watch = { status: null, at: 0, session: null, token: null, connecting: null };
        watches.set(address, watch);
    }
    const stale = Date.now() - watch.at > PUSH_WATCHDOG_MS;
    if ((!watch.session || stale) && Date.now() >= (health.get(address)?.retryAt ?? 0)) {
        await connectWatch(address, model, watch).catch(() => undefined);
    }
    return watch.session && Date.now() - watch.at <= PUSH_WATCHDOG_MS ? watch.status : null;
}

/** Read one unit, the way its firmware allows. Null when it is not answering,
 *  or is being left alone after not answering. */
async function readUnit(unit: PhilipsUnit): Promise<Status | null> {
    const model = modelOfUnit(unit);
    if (model?.nudge) return readPushed(unit.address, model);
    if (Date.now() < (health.get(unit.address)?.retryAt ?? 0)) return null;
    try {
        const status = await philips.readPhilips(unit.address);
        health.delete(unit.address);
        return status;
    } catch (error) {
        if (!(error instanceof DriverError)) throw error;
        failed(unit.address);
        return null;
    }
}

/** Units that stopped answering at their address, found again by their id. */
const moved = new Map<string, string>();
const looked = new Map<string, number>();

/** The key scheme each unit the table does not list was last read with. */
const generations = new Map<string, PhilipsModel["generation"]>();

function located(unit: PhilipsUnit): PhilipsUnit {
    const address = moved.get(unit.deviceId);
    return address ? { ...unit, address } : unit;
}

async function relocate(units: readonly PhilipsUnit[]): Promise<void> {
    const findable = units.filter((unit) => unit.infoId);
    if (findable.length === 0) return;
    const key = findable
        .map((unit) => unit.deviceId)
        .sort()
        .join(",");
    if (Date.now() - (looked.get(key) ?? 0) < LOOK_AGAIN_MS) return;
    looked.set(key, Date.now());
    const found = await philips.scanPhilips(await subnetTargets());
    for (const unit of findable) {
        const seen = found.find((entry) => entry.deviceId === unit.infoId);
        if (seen && seen.address !== located(unit).address && !forbiddenAddress(seen.address)) {
            moved.set(unit.deviceId, seen.address);
        }
    }
}

/**
 * Find out what is at an address and read it for the first time: who it is,
 * then its status the way its firmware allows. A unit that says who it is and
 * then never answers a status read has had local control switched off.
 */
async function firstRead(
    address: string,
    found: philips.PhilipsFound | null
): Promise<PhilipsUnit> {
    const model = found ? philipsModelOf(found.model.slice(0, 9)) : null;
    let status: Status;
    try {
        if (model?.nudge) {
            const opened = await philips.nudgedPhilips(address, nudgeFor(model.nudge, null));
            opened.session.close();
            status = opened.status;
        } else {
            status = await philips.readPhilips(address);
        }
    } catch (error) {
        if (error instanceof DriverError && error.message === philips.PHILIPS_QUIET && found) {
            throw new DriverError(philips.PHILIPS_LOCAL_OFF, "refused");
        }
        throw error;
    }
    const deviceId =
        typeof status.DeviceId === "string" && status.DeviceId.trim()
            ? status.DeviceId.trim()
            : address;
    const wifi = typeof status.WifiVersion === "string" ? status.WifiVersion : "";
    return {
        address,
        deviceId: deviceId.slice(0, 120),
        infoId: found?.deviceId ?? "",
        model: (text(status, MODEL_KEYS) || found?.model || "").slice(0, 120),
        wifi: wifi.slice(0, 120),
        name: (text(status, NAME_KEYS) || found?.name || "").slice(0, 120)
    };
}

export const philipsCoapDriver: DeviceDriver = {
    connection: PHILIPS_COAP,

    /** Find the units - at the address typed, or on the network - and read each
     *  once. What is stored is where they are and what they are. */
    async verify(credentials) {
        const typed = credentials.host?.trim() ?? "";
        if (typed) {
            const address = await unitAddressOf(typed);
            const [found] = await philips.scanPhilips([address]);
            try {
                const unit = await firstRead(address, found ?? null);
                return { host: typed, units: JSON.stringify([unit]) };
            } catch (error) {
                if (error instanceof DriverError && error.message === philips.PHILIPS_QUIET) {
                    throw new DriverError(
                        "No Philips air purifier answered at that address. Check it is switched on and on the same network as Polaris.",
                        "unreachable"
                    );
                }
                throw error;
            }
        }
        const found = (await philips.scanPhilips(await subnetTargets())).filter(
            (unit) => !forbiddenAddress(unit.address)
        );
        if (found.length === 0) {
            throw new DriverError(
                "No Philips air purifier answered on this network. Type the unit's address instead: your router lists it among the connected devices.",
                "unreachable"
            );
        }
        const reads = await Promise.allSettled(found.map((unit) => firstRead(unit.address, unit)));
        const units: PhilipsUnit[] = [];
        let localOff = false;
        for (const read of reads) {
            if (read.status === "fulfilled") {
                units.push(read.value);
                continue;
            }
            if (!(read.reason instanceof DriverError)) throw read.reason;
            if (read.reason.message === philips.PHILIPS_LOCAL_OFF) localOff = true;
        }
        if (units.length === 0) {
            throw new DriverError(
                localOff
                    ? philips.PHILIPS_LOCAL_OFF
                    : "The air purifiers on this network said who they are but would not answer a read. Switch them off and on again and try once more.",
                localOff ? "refused" : "unreachable"
            );
        }
        return { host: "", units: JSON.stringify(units) };
    },

    async list(credentials) {
        const units = unitsOf(credentials);
        let statuses = await Promise.all(units.map((unit) => readUnit(located(unit))));
        const lost = units.filter((_, index) => statuses[index] === null);
        if (lost.length > 0) {
            const before = lost.map((unit) => located(unit).address);
            await relocate(units).catch(() => undefined);
            if (lost.some((unit, index) => located(unit).address !== before[index])) {
                statuses = await Promise.all(
                    units.map((unit, index) => statuses[index] ?? readUnit(located(unit)))
                );
            }
        }
        units.forEach((unit, index) => {
            const status = statuses[index];
            if (status && !modelOfUnit(unit))
                generations.set(unit.deviceId, generationOf(status, null));
        });
        return units.map((unit, index) => philipsSnapshot(located(unit), statuses[index] ?? null));
    },

    async act(credentials, device, action, command) {
        const unit = unitsOf(credentials).find((entry) => entry.deviceId === device.externalId);
        if (!unit) throw new HomeError("That device is not here");
        const here = located(unit);
        const model = modelOfUnit(here);
        const watch = watches.get(here.address);
        const generation = model
            ? model.generation
            : watch?.status
              ? generationOf(watch.status, null)
              : (generations.get(here.deviceId) ??
                generationOf(await philips.readPhilips(here.address), null));
        const values = philipsValues(model, generation, action, command);
        // A push-only unit serves one client: its command goes on the link
        // already open to it, and the push that follows is its new state.
        if (model?.nudge && watch?.session) {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                await watch.session.sync().catch(() => undefined);
                if (await watch.session.control(values)) return;
            }
            throw new DriverError(philips.PHILIPS_REFUSED, "refused");
        }
        await philips.controlPhilips(here.address, values);
    },

    /** Keep a unit's new address once it has been found there. */
    async renew(credentials) {
        let units: PhilipsUnit[];
        try {
            units = unitsOf(credentials);
        } catch {
            return null;
        }
        if (!units.some((unit) => located(unit).address !== unit.address)) return null;
        return { ...credentials, units: JSON.stringify(units.map(located)) };
    },

    /** Let go of any link held open to these units. */
    async forget(credentials) {
        let units: PhilipsUnit[];
        try {
            units = unitsOf(credentials);
        } catch {
            return;
        }
        for (const unit of units) {
            const watch = watches.get(located(unit).address);
            if (watch) closeWatch(watch);
            watches.delete(located(unit).address);
        }
    }
};

/** For the tests: forget every backoff, move and open link. */
export function resetPhilipsState(): void {
    for (const watch of watches.values()) closeWatch(watch);
    watches.clear();
    health.clear();
    moved.clear();
    looked.clear();
    generations.clear();
}
