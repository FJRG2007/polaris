/**
 * Telling "the same network as Polaris" from "somewhere on the internet".
 *
 * It matters because of what a wrong answer costs. A server standing two metres
 * away, on the same switch, can be reached through its public name - out to the
 * router, back in through the port forward, and every byte of a file transfer
 * makes that trip twice. It works, so nothing looks wrong; it is simply slower
 * than it has any reason to be, it depends on the router's willingness to
 * hairpin, and it stops working the moment the line does - which is the moment
 * somebody most wants to reach the machine in the next room.
 *
 * So: only the three private ranges count. Not the whole of what a firewall
 * would call non-public - carrier-grade NAT, link-local and the documentation
 * ranges are all reserved without being reachable from here, and treating one of
 * them as "nearby" would point Polaris at a machine that cannot answer. This is
 * deliberately narrower than `isPrivateIp` in `cidr.ts`, which answers a
 * different question (is this address routable on the internet) for a different
 * caller.
 *
 * IPv4 only, and on purpose rather than by omission: a v6 network hands out
 * globally routable addresses to machines on the same LAN, so "is it private"
 * stops being the same question as "is it near me" and the prefix comparison
 * that works here would be wrong there.
 */

/** Whether an address is in one of the three ranges a home or office network is
 *  built out of. */
export function isLocalAddress(value: string): boolean {
    const parts = value.trim().split(".");
    if (parts.length !== 4) return false;
    const numbers = parts.map((part) => Number(part));
    if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a = 0, b = 0] = numbers;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return a === 192 && b === 168;
}

/**
 * Whether two addresses look like they are on the same piece of wire.
 *
 * The first three octets, which is the /24 almost every home and small office
 * network actually is. It is a guess rather than a subnet calculation - Polaris
 * knows its own address and not its mask - but it is the guess that is right
 * nearly always, and being wrong only costs one connection attempt that fails
 * before anything is changed.
 */
export function sameLocalNetwork(one: string, other: string): boolean {
    if (!isLocalAddress(one) || !isLocalAddress(other)) return false;
    return one.split(".").slice(0, 3).join(".") === other.split(".").slice(0, 3).join(".");
}

/**
 * The addresses a machine reported that Polaris could plausibly reach directly,
 * best first.
 *
 * Same network before merely private: a machine with an address on Polaris' own
 * /24 is one hop away, while one on a different private range may be behind a
 * router that does not route between them. Both are worth trying, in that order,
 * because trying costs one handshake that either answers as the machine or does
 * not.
 *
 * Nothing here is trusted. Every candidate is verified by connecting to it and
 * checking it presents the host key this machine already committed to, so an
 * address pointing at somebody else's box fails exactly as it would have.
 */
export function localCandidates(reported: readonly string[], near: string | null): string[] {
    if (!near || !isLocalAddress(near)) return [];
    const seen = new Set<string>();
    const here: string[] = [];
    const elsewhere: string[] = [];
    for (const raw of reported) {
        const value = raw.trim();
        if (!value || seen.has(value) || !isLocalAddress(value)) continue;
        // Polaris' own address is not a candidate for reaching another machine:
        // on a host-networked install it is the box Polaris runs on.
        if (value === near) continue;
        seen.add(value);
        (sameLocalNetwork(value, near) ? here : elsewhere).push(value);
    }
    return [...here, ...elsewhere];
}

/**
 * Whether an address Polaris already holds is the local one it would rather use.
 *
 * The question behind the offer to switch: there is nothing to gain from moving
 * a server that is already reached across the room, and a button that says
 * otherwise is a button that appears to do nothing.
 */
export function alreadyLocal(address: string, near: string | null): boolean {
    if (!near) return false;
    return sameLocalNetwork(address, near);
}
