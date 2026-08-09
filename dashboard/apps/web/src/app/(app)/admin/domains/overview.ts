/**
 * What the domains panel draws from, in one shape.
 *
 * Its own module because both ends need it: the endpoint answers with it and the
 * browser parses it back. Composed from the services' own types rather than
 * restated - every field is a string, a number or an array of them, so the shapes
 * cross the wire unchanged and there is no second definition to drift.
 */

import type { DomainConfig } from "@/lib/domain-service";
import type { CheckedAddress } from "@/lib/address-health";
import type { DomainZoneConfig } from "@/lib/domain-zones";
import type { OwnerDomainPolicy } from "@/lib/owner-domains-policy";

/** Where the panel reads all of this from. */
export const DOMAINS_OVERVIEW_URL = "/api/admin/domains/overview";

export interface DomainsOverview {
    config: DomainConfig;
    /** The zone layout, which the address suggestions are proposed from. */
    zones: DomainZoneConfig;
    /** Every name the deployment answers on, with the last sweep's verdict. */
    addresses: CheckedAddress[];
    /** Where the dashboard answers while no app domain is configured. */
    effectiveAppUrl: string;
    /** Whether accounts may bring domains of their own, and how many. */
    ownerPolicy: OwnerDomainPolicy;
}
