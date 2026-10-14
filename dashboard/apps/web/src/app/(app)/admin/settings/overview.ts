/**
 * What the Settings page fills itself in with after it has painted.
 *
 * The shape lives here rather than in the route so the client view and the route
 * that answers it read the same declaration - and so the page can import the
 * type without importing the route's Prisma and network work.
 */

import type { UpdateStatus } from "@/lib/update-service";
import type { CheckedAddress } from "@/lib/address-health";

export interface SettingsOverview {
    /** Each part is null when it did not answer in time this round; the page
     *  keeps that part's placeholder and asks again, and shows the rest. */
    readonly status: UpdateStatus | null;
    readonly addresses: CheckedAddress[] | null;
    /** The box's external address, and the one it answers on itself. Either can
     *  be unknown: a container behind NAT cannot always see either from the
     *  inside. Null as a whole when the network status did not answer. */
    readonly network: { readonly publicIp: string | null; readonly serverIp: string | null } | null;
}
