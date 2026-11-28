/**
 * Which addresses Polaris will open a raw printer socket to.
 *
 * A port 9100 sender is a way to put arbitrary bytes on any host the server can
 * reach, so it only ever dials a literal IPv4 on the local network: RFC 1918
 * space, or 169.254/16 where a printer that found no DHCP server assigned itself
 * one. Never a hostname (nothing to re-resolve somewhere else later), never
 * loopback (the server's own services), never the internet.
 */

import * as cidr from "../cidr.js";
import * as network from "../local-network.js";

export const DEFAULT_RAW_PORT = 9100;

export function isPrinterAddress(address: string): boolean {
    const value = address.trim();
    if (value.includes(":") || !cidr.isIpv4(value)) return false;
    return network.isLocalAddress(value) || cidr.ipInCidr(value, "169.254.0.0/16");
}

/** Raw print ports: 9100 and the two next to it that multi-port print servers use. */
export function isPrinterPort(port: number): boolean {
    return port === 9100 || port === 9101 || port === 9102;
}
