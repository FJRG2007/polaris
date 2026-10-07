/**
 * One address in, one open driver out.
 *
 * The drivers are imported lazily rather than at the top of this module. Each
 * pulls in a database client - `pg`, `mysql2`, `mongodb`, `ioredis` - and this
 * module is reached from a server action, so importing all four eagerly would
 * load every client into every request that touched the data browser, including
 * the ones that only listed connections.
 */

import * as data from "./driver";
import { tlsRefusal } from "./tls";
import { openTunnel, TunnelError } from "./tunnel";

export async function openDriver(address: data.DataAddress): Promise<data.DataDriver> {
    switch (address.engine) {
        case "postgres": {
            const { PostgresDriver } = await import("./drivers/postgres");
            return new PostgresDriver(address);
        }
        case "mysql":
        case "mariadb": {
            const { MysqlDriver } = await import("./drivers/mysql");
            return new MysqlDriver(address);
        }
        case "mongo": {
            const { MongoDriver } = await import("./drivers/mongo");
            return new MongoDriver(address);
        }
        case "redis": {
            const { RedisDriver } = await import("./drivers/redis");
            return new RedisDriver(address);
        }
        default: {
            // Unreachable while `DataEngine` is the five above, and a compile
            // error the moment a sixth is added without a driver for it.
            const unreachable: never = address.engine;
            throw new data.DataRequestError(`No driver for ${String(unreachable)}.`);
        }
    }
}

/**
 * Open a driver, do one thing with it, and close it whatever happened.
 *
 * Every read the screens do goes through here, so a connection is never left
 * open by a path that threw - which on Postgres would hold a backend, and on
 * Redis a socket, until the process noticed.
 */
export async function withDriver<T>(
    address: data.DataAddress,
    use: (driver: data.DataDriver) => Promise<T>
): Promise<T> {
    return withRoute(address, (reached) => withOpenDriver(reached, use));
}

/**
 * `withDriver`, on another database of the same server.
 *
 * Null, or the database the connection already names, is `withDriver` itself.
 * Anything else is a name that came from a browser, so it is opened only once
 * the server has listed it for this account (`serverDatabases`), over a first
 * connection to the configured database - the same credentials, the same TLS
 * and, through one tunnel for both, the same SSH route. A name that is not on
 * that list is refused before anything dials it.
 *
 * This is how Beekeeper Studio switches databases on Postgres too: the server's
 * settings are kept and a new connection is made to the other database.
 */
export async function withDriverOn<T>(
    address: data.DataAddress,
    database: string | null | undefined,
    use: (driver: data.DataDriver) => Promise<T>
): Promise<T> {
    if (database === null || database === undefined || database === address.database) {
        return withDriver(address, use);
    }
    return withRoute(address, async (reached) => {
        const listed = await withOpenDriver(reached, (driver) =>
            serverDatabases(address, driver)
        );
        if (!listed.includes(database)) throw new data.DataRequestError(data.NO_SUCH_DATABASE);
        return withOpenDriver({ ...reached, database }, use);
    });
}

/**
 * The databases a connection may switch to, from a driver already open on it.
 *
 * Null for an engine that has no such list (its namespaces are the databases
 * already, or there are none). A confined address - Polaris' own - lists only
 * itself, whatever else shares its server.
 */
export async function serverDatabases(
    address: data.DataAddress,
    driver: data.DataDriver
): Promise<string[]> {
    if (!driver.databases) return address.database ? [address.database] : [];
    if (address.confined) return address.database ? [address.database] : [];
    return driver.databases();
}

/** Reach the address - through its SSH tunnel when it has one - for the length
 *  of one call. */
async function withRoute<T>(
    address: data.DataAddress,
    work: (reached: data.DataAddress) => Promise<T>
): Promise<T> {
    if (!address.tunnel) return work(address);

    // Through SSH: the driver dials a loopback port that leads to the database
    // as the SSH server sees it, and the tunnel closes with the call.
    const tunnel = await openTunnel(address.tunnel, address.host, address.port).catch(
        (error: unknown) => {
            if (error instanceof TunnelError) throw new data.DataRequestError(error.message);
            throw error;
        }
    );
    try {
        return await work({ ...address, host: tunnel.host, port: tunnel.port, tunnel: null });
    } finally {
        tunnel.close();
    }
}

async function withOpenDriver<T>(
    address: data.DataAddress,
    work: (driver: data.DataDriver) => Promise<T>
): Promise<T> {
    const driver = await openDriver(address);
    try {
        return await work(driver);
    } catch (error) {
        // A certificate that did not check out is the reader's to act on, and
        // is said as itself rather than as whatever the driver wrapped it in.
        const refusal = address.tls.mode === "disable" ? null : tlsRefusal(error, address.tls.name);
        if (refusal) throw new data.DataRequestError(refusal);
        throw error;
    } finally {
        await driver.close();
    }
}
