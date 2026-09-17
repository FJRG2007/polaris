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
                        if (typeof name !== "string") return undefined;
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
    if (!found || !(name in found)) {
        throw new Error(`The dashboard offers apps no ${side} service "${area}.${name}"`);
    }
    return found[name];
}
