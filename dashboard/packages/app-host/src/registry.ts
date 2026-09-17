/**
 * Where the dashboard leaves its services for the apps to find.
 *
 * On `globalThis` under a registered symbol, so every copy of this package in a
 * process - the dashboard's, and one bundled with an app - reads the same slot.
 */

export type Side = "server" | "client";

const SLOTS: Record<Side, symbol> = {
    server: Symbol.for("polaris.app-host.server"),
    client: Symbol.for("polaris.app-host.client")
};

type Slots = { [key: symbol]: Record<string, Record<string, unknown>> | undefined };

/** Keys a runtime reaches for on its own rather than services an app asked for:
 *  `await` on an area object, `JSON.stringify` on one. Answering `undefined`
 *  makes an area behave as the plain object it is, instead of failing with the
 *  name of a service nobody wrote. */
const PROBES = new Set(["then", "toJSON"]);

export function provide(side: Side, services: object): void {
    (globalThis as unknown as Slots)[SLOTS[side]] = services as Record<string, Record<string, unknown>>;
}

export function provided(side: Side): Record<string, Record<string, unknown>> | undefined {
    return (globalThis as unknown as Slots)[SLOTS[side]];
}

/**
 * The services of one side, as `proxy.<area>.<name>`.
 *
 * Read when a name is looked up, not when this is created, so an app module can
 * take what it needs at its top level. What happens when nothing has been
 * provided yet is the side's call - see `unprovided`.
 */
export function hostProxy<T extends object>(
    side: Side,
    unprovided: (area: string, name: string) => unknown
): T {
    return new Proxy({} as T, {
        get: (_target, area) => {
            if (typeof area !== "string") return undefined;
            return new Proxy(
                {},
                {
                    get: (_inner, name) => {
                        if (typeof name !== "string" || PROBES.has(name)) return undefined;
                        const services = provided(side);
                        if (services) return lookup(services, side, area, name);
                        return unprovided(area, name);
                    }
                }
            );
        }
    });
}

export function lookup(
    services: Record<string, Record<string, unknown>>,
    side: Side,
    area: string,
    name: string
): unknown {
    const found = services[area];
    if (!found || !Object.hasOwn(found, name)) {
        throw new Error(`The dashboard offers apps no ${side} service "${area}.${name}"`);
    }
    return found[name];
}
