/**
 * What the firewall's scope-target picker may ask for: which kind of target, and
 * the search, cursor and ids every paged option list takes. Free of anything
 * server-only so the picker can import it.
 */

import { z } from "zod";
import { pageFields } from "@/lib/deploy-target-options-schema";

/** The scope kinds that name one thing - the instance-wide two need no target. */
export const firewallTargetKindSchema = z.enum([
    "server-group",
    "server",
    "project",
    "environment",
    "marketplace",
    "application"
]);
export type FirewallTargetKind = z.infer<typeof firewallTargetKindSchema>;

export const firewallScopeOptionsRequestSchema = z
    .object({ ...pageFields, kind: firewallTargetKindSchema })
    .strict();

export type FirewallScopeOptionsRequest = z.input<typeof firewallScopeOptionsRequestSchema>;

/** One scope target as the picker shows it. */
export interface FirewallScopeOption {
    readonly id: string;
    readonly name: string;
    /** Where it sits - the project, or project and environment - when that is not
     *  the whole of its name. */
    readonly path: string | null;
}
