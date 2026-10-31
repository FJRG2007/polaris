/**
 * The address and hardware address of a camera or a device reached on this
 * network, for whoever manages it. A device behind a maker's cloud has neither,
 * and gets nothing here.
 *
 * Server-only.
 */

import { host } from "@polaris/app-host";
import * as registry from "./device-connections";
import type { DeviceAccountView } from "./device-accounts";
import { lanDetails, type LanDetails } from "@polaris/core";

export interface AccountNetwork {
    readonly id: string;
    readonly label: string;
    readonly details: LanDetails;
}

function neighbours(): Promise<ReadonlyMap<string, string>> {
    return host.hostNetwork.readNeighbourTable().catch(() => new Map<string, string>());
}

export async function addressDetails(stored: string): Promise<LanDetails | null> {
    return lanDetails(stored, await neighbours());
}

/** One entry per address field a connected account has filled in. Pure over the
 *  table, so the accounts with no address are seen to give nothing. */
export function accountNetworks(
    accounts: readonly DeviceAccountView[],
    table: ReadonlyMap<string, string>
): AccountNetwork[] {
    return accounts.flatMap((account) => {
        const fields = registry.deviceConnection(account.connection)?.fields ?? [];
        return fields.flatMap((field) => {
            const details =
                field.address === true ? lanDetails(account.settings[field.key], table) : null;
            return details
                ? [{ id: `${account.id}:${field.key}`, label: account.label, details }]
                : [];
        });
    });
}

export async function listAccountNetworks(
    accounts: readonly DeviceAccountView[]
): Promise<AccountNetwork[]> {
    return accountNetworks(accounts, await neighbours());
}
