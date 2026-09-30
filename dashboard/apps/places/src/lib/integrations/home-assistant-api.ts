/**
 * Home Assistant's REST API, as much of it as Places needs.
 *
 * Three calls, from Home Assistant's developer documentation
 * (developers.home-assistant.io/docs/api/rest): `GET /api/` to prove the token,
 * `GET /api/states` for everything at once, and
 * `POST /api/services/<domain>/<service>` to do something. A long-lived access
 * token in a bearer header opens all three.
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
    entityId: string
): Promise<void> {
    const response = await call(home, "POST", `/api/services/${domain}/${service}`, {
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
