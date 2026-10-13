"use server";

/**
 * What each role of the organization is held to in its CRM. Every input is
 * checked against a schema here.
 */

import * as roles from "../lib/roles";
import { requireCrmActor } from "../lib/access";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { roleRuleSchema, type ObjectRule } from "../model/roles";

export interface RolesOpening {
    /** The organization whose CRM this is; null on the reader's own. */
    readonly orgName: string | null;
    /** Null for a reader who may not manage the organization's roles. */
    readonly reading: roles.RolesReading | null;
}

export async function rolesAction(): Promise<Outcome<RolesOpening>> {
    return outcome(async () => {
        const actor = await requireCrmActor();
        return {
            orgName: actor.shelf.orgName,
            reading: actor.shelf.orgId && actor.manageRoles ? await roles.listRoleRules(actor) : null
        };
    });
}

export async function saveRoleRuleAction(input: unknown): Promise<Outcome<{ rule: ObjectRule }>> {
    const parsed = roleRuleSchema.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        rule: await roles.saveRoleRule(await requireCrmActor(), parsed.data)
    }));
}
