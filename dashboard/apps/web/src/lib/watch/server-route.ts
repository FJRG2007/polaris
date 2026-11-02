/**
 * A server's address in Watch reads as the name its owner gave it. Pure, and the
 * name only stands in for the id when it can never mean anything else.
 */

const READABLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NamedServer {
    readonly id: string;
    readonly name: string;
}

/** The server's name when it is unique, readable and not a reserved word; else its id. */
export function serverSlug(servers: readonly NamedServer[], server: NamedServer, reserved: string): string {
    const usable =
        READABLE.test(server.name) &&
        !UUID.test(server.name) &&
        server.name.toLowerCase() !== reserved.toLowerCase() &&
        servers.filter(({ name }) => name.toLowerCase() === server.name.toLowerCase()).length === 1;
    return usable ? server.name : server.id;
}

/** The server an address means, by id or by its name. */
export function serverFromSlug<T extends NamedServer>(servers: readonly T[], slug: string): T | null {
    const wanted = slug.toLowerCase();
    return (
        servers.find(({ id }) => id === slug) ??
        servers.find(({ name }) => name.toLowerCase() === wanted) ??
        null
    );
}

/**
 * What an address in Watch means, and the address it should read as. `machine` is
 * the box Polaris runs on, whether or not it has a row; `here` is every row that
 * turned out to be it and `remote` every other. A `host` of null is the machine.
 */
export function addressedServer<T extends NamedServer>(
    slug: string,
    reserved: string,
    machine: NamedServer,
    here: readonly T[],
    remote: readonly T[]
): { host: T | null; address: string } | null {
    const servers = [machine, ...remote];
    const found = slug === reserved ? machine : (serverFromSlug(servers, slug) ?? serverFromSlug(here, slug));
    if (!found) return null;
    const host = remote.find(({ id }) => id === found.id) ?? null;
    return { host, address: serverSlug(servers, host ?? machine, reserved) };
}
