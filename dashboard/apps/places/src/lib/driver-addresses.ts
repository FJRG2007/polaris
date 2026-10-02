/**
 * A driver that is handed a MAC wherever its connection asked for an address.
 *
 * The registry lets every address field take a hardware (MAC) address
 * (`ConnectionField.address`), and what is stored is the MAC. No driver knows
 * that: each one is wrapped here, once, by the account layer, so it is handed
 * credentials whose MAC has become the IP the device answers on right now - and
 * whatever it hands back to be stored (a bridge's key next to its address, a
 * renewed sign-in) has that IP turned back into the MAC, so the next use looks
 * it up again instead of dialling an address the router may lend to somebody
 * else.
 *
 * When a call fails because the device did not answer, the MAC is looked up
 * afresh - the router may have moved it - and the call is made once more at the
 * new address. That is what keeps a device given by MAC working through a DHCP
 * change with nobody touching anything.
 *
 * Server-only.
 */

import * as registry from "./device-connections";
import { forgetMac, locateMac, type OwnLookup } from "./integrations/mac-locate";
import {
    DriverError,
    type Credentials,
    type DeviceDriver,
    type DevicePairing
} from "./drivers/contract";

/** One address field given as a MAC, and where it was found for this call. */
interface Located {
    readonly key: string;
    readonly mac: string;
    readonly address: string;
}

/** The sentence for a MAC nothing answers as. Shaped in `refusal-text.ts`. */
export function macNotFound(mac: string): string {
    return `Nothing on this network answers as ${mac}. Check the device is switched on and on the same network as Polaris, or type its IP address instead.`;
}

/** Whether a connection has any address field given as a MAC in these
 *  credentials. Most do not, and they are passed straight through. */
function macFields(connection: string, credentials: Credentials) {
    const declared = registry.deviceConnection(connection)?.fields ?? [];
    return declared.flatMap((field) => {
        const mac = registry.fieldMac(field, credentials[field.key]);
        return mac ? [{ key: field.key, mac }] : [];
    });
}

async function locate(
    connection: string,
    credentials: Credentials,
    own: OwnLookup | undefined,
    previous?: readonly Located[]
): Promise<{ credentials: Credentials; located: Located[] }> {
    const wanted = macFields(connection, credentials);
    if (wanted.length === 0) return { credentials, located: [] };
    const located: Located[] = [];
    const resolved: Record<string, string> = { ...credentials };
    for (const { key, mac } of wanted) {
        const before = previous?.find((entry) => entry.key === key)?.address;
        const address = await locateMac(mac, before ? { fresh: true, avoid: before, own } : { own });
        if (!address) throw new DriverError(macNotFound(mac), "unreachable");
        located.push({ key, mac, address });
        resolved[key] = address;
    }
    return { credentials: resolved, located };
}

/** What a driver handed back, with the addresses it was given turned back into
 *  the MACs they came from. */
function restore(
    returned: Credentials | null | void,
    located: readonly Located[]
): Credentials | null | void {
    if (!returned || located.length === 0) return returned;
    const next: Record<string, string> = { ...returned };
    for (const { key, mac, address } of located) {
        if (next[key]?.trim() === address) next[key] = mac;
    }
    return next;
}

/**
 * Run one call with the MACs resolved. A device that did not answer at the
 * address it was found at is looked for once more, and the call repeated if it
 * turned up somewhere else.
 */
async function run<T>(
    connection: string,
    credentials: Credentials,
    own: OwnLookup | undefined,
    call: (resolved: Credentials) => Promise<T>
): Promise<{ value: T; located: Located[] }> {
    const first = await locate(connection, credentials, own);
    try {
        return { value: await call(first.credentials), located: first.located };
    } catch (caught) {
        if (
            first.located.length === 0 ||
            !(caught instanceof DriverError) ||
            caught.kind !== "unreachable"
        ) {
            throw caught;
        }
        for (const { mac } of first.located) forgetMac(mac);
        const again = await locate(connection, credentials, own, first.located).catch(() => null);
        const moved = again?.located.some(
            (entry, index) => entry.address !== first.located[index]?.address
        );
        if (!again || !moved) throw caught;
        return { value: await call(again.credentials), located: again.located };
    }
}

/** The driver, taking MACs where its connection takes addresses. A driver that
 *  can find its own units by MAC (`locate`) is asked that way too, which is what
 *  works where the host's neighbour table cannot be read. */
export function withAddresses(driver: DeviceDriver): DeviceDriver {
    const id = driver.connection;
    const own: OwnLookup | undefined = driver.locate?.bind(driver);
    const pair: DevicePairing | undefined = driver.pair
        ? {
              start: async (fields) =>
                  (await run(id, fields, own, (resolved) => driver.pair!.start(resolved))).value,
              poll: async (fields, state) => {
                  const { value, located } = await run(id, fields, own, (resolved) =>
                      driver.pair!.poll(resolved, state)
                  );
                  return value.done
                      ? { ...value, credentials: restore(value.credentials, located) ?? {} }
                      : value;
              },
              ...(driver.pair.file ? { file: driver.pair.file.bind(driver.pair) } : {})
          }
        : undefined;
    return {
        connection: id,
        async verify(credentials) {
            const { value, located } = await run(id, credentials, own, (resolved) =>
                driver.verify(resolved)
            );
            return restore(value, located) ?? undefined;
        },
        list: async (credentials) =>
            (await run(id, credentials, own, (resolved) => driver.list(resolved))).value,
        act: async (credentials, device, action, command) =>
            (
                await run(id, credentials, own, (resolved) =>
                    driver.act(resolved, device, action, command)
                )
            ).value,
        ...(driver.history
            ? {
                  history: async (credentials: Credentials, limit: number) =>
                      (await run(id, credentials, own, (resolved) => driver.history!(resolved, limit)))
                          .value
              }
            : {}),
        ...(driver.probe
            ? {
                  probe: async (credentials: Credentials, externalIds: readonly string[]) =>
                      (
                          await run(id, credentials, own, (resolved) =>
                              driver.probe!(resolved, externalIds)
                          )
                      ).value
              }
            : {}),
        ...(driver.renew
            ? {
                  async renew(credentials: Credentials) {
                      const { value, located } = await run(id, credentials, own, (resolved) =>
                          driver.renew!(resolved)
                      );
                      return restore(value, located) ?? null;
                  }
              }
            : {}),
        ...(driver.forget
            ? {
                  forget: async (credentials: Credentials) =>
                      (await run(id, credentials, own, (resolved) => driver.forget!(resolved)))
                          .value
              }
            : {}),
        ...(pair ? { pair } : {}),
        ...(driver.discover ? { discover: driver.discover.bind(driver) } : {}),
        ...(driver.locate ? { locate: driver.locate.bind(driver) } : {})
    };
}
