/**
 * The CRM rules of an organization's roles: reading them for the screen that
 * sets them, and storing one. Only somebody whose role manages the
 * organization's roles may do either; the owner and a full-access role are
 * never held to a rule, so they are listed and cannot be given one.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { prisma } from "@polaris/db";
import { CrmRefusal } from "./errors";
import { loadFields } from "./fields";
import * as model from "../model/roles";
import { host } from "@polaris/app-host";
import type { CrmActor } from "./access";
import { CRM_OBJECTS } from "@polaris/core";
import type { CrmObject, FieldDef } from "../model/objects";

/** One role of the organization as the rules screen lists it. */
export interface RoleSummary {
    readonly slug: string;
    readonly name: string;
    /** Holds every permission, so no rule applies to it. */
    readonly full: boolean;
    readonly rules: model.RoleRules;
}

export interface RolesReading {
    readonly roles: RoleSummary[];
    /** The fields added on the shelf, per kind of record, so a rule can name them. */
    readonly fields: Readonly<Record<CrmObject, FieldDef[]>>;
}

async function refuse(key: "manage" | "role" | "unknownField" | "nameLocked"): Promise<never> {
    const t = await crmT();
    throw new CrmRefusal(t(`roles.errors.${key}`));
}

async function requireManager(actor: CrmActor): Promise<string> {
    if (!actor.shelf.orgId || !actor.manageRoles) return refuse("manage");
    return actor.shelf.orgId;
}

async function orgRoles(actor: CrmActor, orgId: string) {
    return host.crmHost.crmOrgRoles({ id: actor.user.id, isAdmin: actor.user.isAdmin }, orgId);
}

/** Every role of the organization with its CRM rules. */
export async function listRoleRules(actor: CrmActor): Promise<RolesReading> {
    const orgId = await requireManager(actor);
    // enigma: bounded - an organization's roles are a short list it writes by
    // hand, and the rules are at most one row per role and kind of record.
    const [roles, rows, ...custom] = await Promise.all([
        orgRoles(actor, orgId),
        prisma.crmRoleRule.findMany({
            where: { orgId },
            select: { role: true, object: true, rows: true, hidden: true, readOnly: true },
            take: 2000
        }),
        ...CRM_OBJECTS.map((object) => loadFields(actor.shelf, object))
    ]);
    return {
        roles: roles.map((role) => ({
            slug: role.slug,
            name: role.name,
            full: role.permissions.includes("*"),
            rules: model.readRules(rows.filter((row) => row.role === role.slug))
        })),
        fields: Object.fromEntries(
            CRM_OBJECTS.map((object, at) => [object, custom[at] ?? []])
        ) as unknown as RolesReading["fields"]
    };
}

/** Store what one role is held to for one kind of record. */
export async function saveRoleRule(
    actor: CrmActor,
    input: model.RoleRuleInput
): Promise<model.ObjectRule> {
    const orgId = await requireManager(actor);
    const role = (await orgRoles(actor, orgId)).find((one) => one.slug === input.role);
    if (!role || role.permissions.includes("*")) return refuse("role");
    const checked = model.checkRule(
        input.object,
        input,
        await loadFields(actor.shelf, input.object)
    );
    if (!checked.ok) return refuse(checked.reason);
    const data = {
        rows: checked.rule.rows,
        hidden: JSON.stringify(checked.rule.hidden),
        readOnly: JSON.stringify(checked.rule.readOnly)
    };
    await prisma.crmRoleRule.upsert({
        where: { orgId_role_object: { orgId, role: input.role, object: input.object } },
        create: { orgId, role: input.role, object: input.object, ...data },
        update: data
    });
    return checked.rule;
}
