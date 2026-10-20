/**
 * The network view: every device the log saw, with the name it goes by and the
 * groups whose lists it gets. Pure, so who lands in which group is asserted
 * without a container.
 */

import { ipInCidr } from "@polaris/core";
import type { SeenDevice } from "./query-log";
import type { DnsSettings } from "./settings";

/** A device as the Devices section lists it. */
export interface NetworkDevice extends SeenDevice {
    /** A name given by hand here, which wins over the router's. */
    readonly ownName: string;
    /** The groups it blocks with; empty is everybody's lists. */
    readonly groups: readonly string[];
}

/** A group entry with `*` read as any run of characters. */
function globMatches(pattern: string, name: string): boolean {
    const source = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${source}$`).test(name);
}

/** Whether one group entry (an address, a range or a name pattern) holds a device. */
export function clientMatches(entry: string, address: string, names: readonly string[]): boolean {
    if (entry === address) return true;
    if (entry.includes("/")) return ipInCidr(address, entry);
    return names.some((name) => name !== "" && globMatches(entry, name));
}

/**
 * The devices the log saw, named and grouped the way the engine treats them:
 * a device gets every group one of its entries matches, by address, range or
 * any name it goes by.
 */
export function networkDevices(
    seen: readonly SeenDevice[],
    settings: Pick<DnsSettings, "devices" | "clientGroups">
): NetworkDevice[] {
    const own = new Map(settings.devices.map((device) => [device.address, device.name]));
    return seen.map((device) => {
        const ownName = own.get(device.address) ?? "";
        const names = [ownName, device.name.toLowerCase()];
        const groups = settings.clientGroups
            .filter((group) =>
                group.clients.some((entry) => clientMatches(entry, device.address, names))
            )
            .map((group) => group.name);
        return { ...device, ownName, groups };
    });
}
