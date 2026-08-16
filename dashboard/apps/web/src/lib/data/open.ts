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
    const driver = await openDriver(address);
    try {
        return await use(driver);
    } finally {
        await driver.close();
    }
}
