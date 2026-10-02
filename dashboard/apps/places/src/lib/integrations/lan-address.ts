/**
 * The addresses a device connection may never dial, whatever somebody typed.
 *
 * A device is on the local network, so private space is allowed - that is the
 * point. What is refused is what no plug, bridge or hub is ever at: this machine
 * itself, link-local space (where a cloud's metadata service answers), multicast
 * and reserved ranges, and the unspecified address.
 *
 * A name is checked by what it resolves to, and the address checked is the one
 * dialed: `guardedLookup` is handed to the socket as its resolver, so a name
 * cannot resolve to one address for the check and another for the connection.
 *
 * Server-only.
 */

import { DriverError } from "../drivers/contract";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";

const FORBIDDEN = new BlockList();
FORBIDDEN.addSubnet("0.0.0.0", 8, "ipv4");
FORBIDDEN.addSubnet("127.0.0.0", 8, "ipv4");
FORBIDDEN.addSubnet("169.254.0.0", 16, "ipv4");
FORBIDDEN.addSubnet("224.0.0.0", 4, "ipv4");
FORBIDDEN.addSubnet("240.0.0.0", 4, "ipv4");
FORBIDDEN.addAddress("100.100.100.200", "ipv4");
FORBIDDEN.addAddress("::", "ipv6");
FORBIDDEN.addAddress("::1", "ipv6");
FORBIDDEN.addSubnet("fe80::", 10, "ipv6");
FORBIDDEN.addSubnet("ff00::", 8, "ipv6");
FORBIDDEN.addAddress("fd00:ec2::254", "ipv6");

const MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Whether an address literal is one a device connection may not dial. Anything
 *  that is not an address at all is refused too. */
export function forbiddenAddress(address: string): boolean {
    const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    const mapped = MAPPED.exec(bare);
    if (mapped) return FORBIDDEN.check(mapped[1]!, "ipv4");
    const family = isIP(bare);
    if (family === 4) return FORBIDDEN.check(bare, "ipv4");
    if (family === 6) return FORBIDDEN.check(bare, "ipv6");
    return true;
}

export function forbiddenError(): DriverError {
    return new DriverError(
        "Polaris does not connect to that address. Use the device's address on your network, such as 10.0.1.30.",
        "refused"
    );
}

/** `dns.lookup`, refusing a name when any address it resolves to is forbidden. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
        if (error) {
            callback(error, "");
            return;
        }
        const first = addresses[0];
        if (!first || addresses.some((entry) => forbiddenAddress(entry.address))) {
            callback(forbiddenError() as unknown as NodeJS.ErrnoException, "");
            return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, first.address, first.family);
    });
};
