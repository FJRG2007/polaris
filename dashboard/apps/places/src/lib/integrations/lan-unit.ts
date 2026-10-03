/**
 * Where a unit on the local network is: an address somebody typed, or every
 * address on this server's own subnet to look through.
 *
 * Shared by the drivers that speak UDP to units on the LAN (Gree, Philips). A
 * subnet is looked through one address at a time because a broadcast from the
 * web container's Docker bridge never reaches the LAN, while a datagram to one
 * address does and its answer comes back through the same NAT entry.
 *
 * Server-only.
 */

import { isIP } from "node:net";
import { deviceHost } from "./lan-http";
import { host } from "@polaris/app-host";
import { HomeError } from "../home-error";
import { lookup } from "node:dns/promises";
import { hostsInCidr } from "../discovery";
import { DriverError } from "../drivers/contract";
import { forbiddenAddress, forbiddenError } from "./lan-address";

/** A typed address, as the IPv4 address it is, refused when it is one no unit
 *  is ever at. */
export async function unitAddressOf(typed: string): Promise<string> {
    const name = deviceHost(typed);
    if (!name) throw new HomeError("Write the address as 192.168.1.30, with no path");
    let address = name;
    if (isIP(name) !== 4) {
        try {
            address = (await lookup(name, { family: 4 })).address;
        } catch {
            throw new DriverError("The device could not be reached.", "unreachable");
        }
    }
    if (forbiddenAddress(address)) throw forbiddenError();
    return address;
}

/** Every other address on this server's own /24, or none when the server's
 *  address on the LAN is not known. */
export async function subnetTargets(): Promise<string[]> {
    const own = await host.hostAddress.getHostLanIp().catch(() => null);
    return own ? hostsInCidr(`${own}/24`).filter((address) => address !== own) : [];
}
