/**
 * Home Assistant's REST API, as much of it as Places needs.
 *
 * Four calls, from Home Assistant's developer documentation
 * (developers.home-assistant.io/docs/api/rest): `GET /api/` to prove the token,
 * `GET /api/states` for everything at once, `POST /api/template` for which
 * entities share a device, and `POST /api/services/<domain>/<service>` to do
 * something. A long-lived access token in a bearer header opens all four.
 *
 * An install on the LAN is plain HTTP; one behind a domain has a real
 * certificate, which is checked against the system's authorities like any other
 * site's. A self-signed one is refused rather than waved through.
 *
 * Server-only.
 */

import { z } from "zod";
import { DriverError } from "../drivers/contract";
import { deviceOrigin, jsonOf, lanRequest } from "./lan-http";

/** Home Assistant's own default port, used when only an address was typed. */
const DEFAULT_PORT = 8123;

/** A whole house's states. Large installs run to a few megabytes; this is well
 *  past that and still a ceiling. */
const MAX_STATES_BYTES = 32_000_000;

export interface HomeAssistant {
    readonly origin: string;
    readonly token: string;
}

export function homeAssistant(url: string, token: string): HomeAssistant | null {
    const origin = deviceOrigin(url, "http", DEFAULT_PORT);
    return origin ? { origin, token } : null;
}

function tokenRefused(): DriverError {
    return new DriverError(
        "Home Assistant refused the token. Make a new long-lived access token on your Home Assistant profile page.",
        "unauthorized"
    );
}

async function call(
    home: HomeAssistant,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    maxBytes?: number
) {
    const response = await lanRequest({
        url: `${home.origin}${path}`,
        method,
        headers: {
            authorization: `Bearer ${home.token}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        maxBytes,
        trust: "system",
        timeoutMs: 15_000
    });
    if (response.status === 401 || response.status === 403) throw tokenRefused();
    return response;
}

/** Whether the token opens the API. `/api/` - with its slash, which their
 *  documentation insists on - answers `{"message": "API running."}`. */
export async function checkHomeAssistant(home: HomeAssistant): Promise<void> {
    const response = await call(home, "GET", "/api/");
    const said = z.object({ message: z.string() }).safeParse(jsonOf(response));
    if (response.status !== 200 || !said.success) {
        throw new DriverError("That address answered, but not as Home Assistant.", "refused");
    }
}

const stateSchema = z.object({
    entity_id: z.string(),
    state: z.string(),
    attributes: z.record(z.string(), z.unknown()).default({})
});

export type HomeAssistantState = z.infer<typeof stateSchema>;

/** Every entity and what it is doing. */
export async function homeAssistantStates(home: HomeAssistant): Promise<HomeAssistantState[]> {
    const response = await call(home, "GET", "/api/states", undefined, MAX_STATES_BYTES);
    if (response.status === 503)
        throw new DriverError(
            "Home Assistant is restarting. Try again in a moment.",
            "unreachable"
        );
    const parsed = z.array(z.unknown()).safeParse(jsonOf(response));
    if (response.status !== 200 || !parsed.success) {
        throw new DriverError("That address answered, but not as Home Assistant.", "refused");
    }
    return parsed.data.flatMap((item) => {
        const state = stateSchema.safeParse(item);
        return state.success ? [state.data] : [];
    });
}

/** One entity and what it is doing, or null when Home Assistant has no such
 *  entity any more. */
export async function homeAssistantState(
    home: HomeAssistant,
    entityId: string
): Promise<HomeAssistantState | null> {
    const response = await call(home, "GET", `/api/states/${encodeURIComponent(entityId)}`);
    if (response.status === 404) return null;
    const parsed = stateSchema.safeParse(jsonOf(response));
    if (response.status !== 200 || !parsed.success) {
        throw new DriverError("That address answered, but not as Home Assistant.", "refused");
    }
    return parsed.data;
}

/** The unit the install shows temperatures in. A climate entity's numbers are
 *  in it, and nothing on the entity says which it is. */
export async function homeAssistantTemperatureUnit(home: HomeAssistant): Promise<"C" | "F"> {
    const response = await call(home, "GET", "/api/config");
    const parsed = z
        .object({ unit_system: z.object({ temperature: z.string() }).passthrough() })
        .passthrough()
        .safeParse(jsonOf(response));
    return response.status === 200 &&
        parsed.success &&
        parsed.data.unit_system.temperature.includes("F")
        ? "F"
        : "C";
}

/**
 * Which entities share a device with each of these, rendered by Home Assistant
 * itself (`POST /api/template`, with its `device_id`, `device_entities` and
 * `to_json` template functions): the REST states carry no device, and a
 * purifier's dust and filter sensors are only known to be its own this way.
 *
 * Empty when the install will not render it - the entities are then read on
 * their own, which loses the grouping and nothing else.
 */
export async function homeAssistantDevices(
    home: HomeAssistant,
    domains: readonly string[]
): Promise<Map<string, readonly string[]>> {
    const sources = domains
        .filter((domain) => /^[a-z_]+$/.test(domain))
        .map((domain) => `states.${domain} | list`)
        .join(" + ");
    if (!sources) return new Map();
    const template =
        "{% set ns = namespace(out=[]) %}" +
        `{% for s in ${sources} %}` +
        "{% set d = device_id(s.entity_id) %}" +
        "{% set ns.out = ns.out + [[s.entity_id, (device_entities(d) if d else [])]] %}" +
        "{% endfor %}{{ ns.out | to_json }}";
    const response = await call(home, "POST", "/api/template", { template });
    if (response.status !== 200) return new Map();
    let rendered: unknown;
    try {
        rendered = JSON.parse(response.body.toString("utf8"));
    } catch {
        return new Map();
    }
    const parsed = z
        .array(z.tuple([z.string().max(255), z.array(z.string().max(255)).max(200)]))
        .max(500)
        .safeParse(rendered);
    return parsed.success ? new Map(parsed.data) : new Map();
}

/**
 * Call one service on one entity.
 *
 * A 400 is Home Assistant saying the entity cannot do that - `lock.open` on a
 * lock without the open feature is the one this is written for - and is said
 * that way rather than as a failure to reach it.
 */
export async function callService(
    home: HomeAssistant,
    domain: string,
    service: string,
    entityId: string,
    /** What the service is told besides the entity: a mode, a temperature. */
    data: Readonly<Record<string, unknown>> = {}
): Promise<void> {
    const response = await call(home, "POST", `/api/services/${domain}/${service}`, {
        ...data,
        entity_id: entityId
    });
    if (response.status === 400) {
        throw new DriverError(
            "Home Assistant would not do that. The device may not support it.",
            "refused"
        );
    }
    if (response.status < 200 || response.status >= 300) {
        throw new DriverError("Home Assistant refused the request.", "refused");
    }
}

const socketMessage = z.object({
    type: z.string(),
    id: z.number().optional(),
    success: z.boolean().optional(),
    event: z
        .object({
            event_type: z.string(),
            data: z.object({
                entity_id: z.string(),
                old_state: z.object({ state: z.string() }).passthrough().nullable().optional(),
                new_state: z.object({ state: z.string() }).passthrough().nullable().optional()
            })
        })
        .optional()
});

/** Domains whose attributes are only details: a change that leaves their state
 *  as it was (a sensor's `last_reset`, a friendly name) is not news. Every other
 *  domain keeps what Polaris shows in its attributes - a climate's setpoint, a
 *  purifier's speed - so any change to it is. */
const STATE_ONLY_DOMAINS = new Set(["sensor", "binary_sensor"]);

/**
 * Hear every entity change as Home Assistant makes it, over its WebSocket API
 * (developers.home-assistant.io/docs/api/websocket): sign in with the token,
 * subscribe to `state_changed`, and hand each changed entity id to `changed`.
 * Resolves when the socket closes or `signal` aborts; rejects when it could
 * not be opened or the token is refused.
 */
export async function listenHomeAssistant(
    home: HomeAssistant,
    changed: (entityId: string) => void,
    signal: AbortSignal
): Promise<void> {
    const { openLanSocket, eachMessage } = await import("./lan-socket");
    const ws = await openLanSocket({
        url: `${home.origin.replace(/^http/, "ws")}/api/websocket`,
        trust: "system",
        signInRefused: tokenRefused().message
    });
    let signedIn = false;
    let refused: DriverError | null = null;
    await eachMessage(
        ws,
        (text) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(text) as unknown;
            } catch {
                return;
            }
            const message = socketMessage.safeParse(parsed);
            if (!message.success) return;
            const said = message.data;
            if (said.type === "auth_required") {
                ws.send(JSON.stringify({ type: "auth", access_token: home.token }));
            } else if (said.type === "auth_ok") {
                signedIn = true;
                ws.send(
                    JSON.stringify({ id: 1, type: "subscribe_events", event_type: "state_changed" })
                );
            } else if (said.type === "auth_invalid") {
                refused = tokenRefused();
                ws.close();
            } else if (said.type === "result" && said.id === 1 && said.success === false) {
                refused = new DriverError(
                    "Home Assistant would not send its changes to Polaris.",
                    "refused"
                );
                ws.close();
            } else if (said.type === "event" && said.event?.event_type === "state_changed") {
                const { entity_id: entityId, old_state: before, new_state: after } =
                    said.event.data;
                const detail =
                    STATE_ONLY_DOMAINS.has(entityId.split(".")[0] ?? "") &&
                    before?.state === after?.state;
                if (!detail) changed(entityId);
            }
        },
        signal
    );
    if (refused) throw refused;
    if (!signedIn && !signal.aborted)
        throw new DriverError("Home Assistant closed the connection.", "unreachable");
}
