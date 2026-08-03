/**
 * Where a device was seen from, written the same way everywhere it appears: the
 * session table, the remembered-devices table, and the panel for one device.
 *
 * A deployment answers on the local network as well as from outside, so the same
 * laptop shows up once as 192.168.1.131 and once as the address its line is seen
 * at - and read on their own, those two rows are two strangers. Wherever the
 * address is a local one it is therefore shown with the public one under it, so
 * the rows for one device can be recognised as one device.
 *
 * The pairing is the network's, not the device's: what it says is that this
 * address is on our network, and our network leaves through that one.
 */

export interface DeviceAddresses {
    ip: string | null;
    /** Set only when `ip` is an address only this network can reach. */
    publicIp: string | null;
    country?: string | null;
}

/** The addresses as one line, for the places with no room for a column: a narrow
 *  layout, or a card that is not a table at all. */
export function addressLine(address: DeviceAddresses): string {
    if (!address.ip) return "";
    const seen = address.publicIp ? `${address.ip} via ${address.publicIp}` : address.ip;
    return address.country ? `${seen} - ${address.country}` : seen;
}

/** The address column's contents. */
export function DeviceAddress({ address }: { address: DeviceAddresses }) {
    if (!address.ip) return <span className="text-muted-foreground">-</span>;
    return (
        <>
            <span className="font-mono">{address.ip}</span>
            {address.country ? ` - ${address.country}` : null}
            {address.publicIp ? (
                <span className="block">
                    via <span className="font-mono">{address.publicIp}</span>
                </span>
            ) : null}
        </>
    );
}
