"use client";

import { Input, Select } from "@polaris/ui";
import { AGENT_CLIS, agentCliById } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { AGENT_ROLES, ROLE_DEFAULTS, roleModelSchema, type RoleAgents } from "@/lib/agents/agent-roles";

/** The value the agent picker uses for "nothing set here". */
const INHERIT = "inherit";

/** Whether every role's model reads as provider/model, or is empty. */
export function roleAgentsValid(value: RoleAgents): boolean {
    return AGENT_ROLES.every((role) => roleModelSchema.safeParse(value[role]?.model ?? "").success);
}

/** The agent and model a coordinator, its workers and a reviewer start on here. */
export function RepoRoleFields({ value, onChange }: { value: RoleAgents; onChange: (next: RoleAgents) => void }) {
    const t = useTranslations("agents");
    // A role put back to the default is left out rather than kept as
    // undefined, so a dialog changed and changed back is not dirty.
    const set = (role: (typeof AGENT_ROLES)[number], agent: string, model: string) => {
        const { [role]: _dropped, ...rest } = value;
        onChange(agent ? { ...rest, [role]: { agent, model } } : rest);
    };

    return (
        <section className="flex min-w-0 flex-col gap-3 border-t border-border pt-4">
            <div className="min-w-0">
                <p className="text-sm font-medium">{t("repoRoles.title")}</p>
                <p className="text-xs text-muted-foreground">{t("repoRoles.intro")}</p>
            </div>
            {AGENT_ROLES.map((role) => {
                const saved = value[role];
                const model = saved?.model ?? "";
                const invalid = !roleModelSchema.safeParse(model).success;
                const fallback = agentCliById(ROLE_DEFAULTS[role].agent)?.label ?? ROLE_DEFAULTS[role].agent;
                return (
                    <div key={role} className="grid min-w-0 gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-start">
                        <span className="truncate pt-2 text-sm">{t(`repoRoles.roles.${role}`)}</span>
                        <Select
                            aria-label={t("repoRoles.agent", { role: t(`repoRoles.roles.${role}`) })}
                            value={saved?.agent ?? INHERIT}
                            onValueChange={(agent) =>
                                set(role, agent === INHERIT ? "" : agent, agent === saved?.agent ? model : "")
                            }
                            options={[
                                { value: INHERIT, label: t("repoRoles.inherit", { agent: fallback }) },
                                ...AGENT_CLIS.map((cli) => ({ value: cli.id, label: cli.label }))
                            ]}
                        />
                        <div className="min-w-0 space-y-1">
                            <Input
                                aria-label={t("repoRoles.model", { role: t(`repoRoles.roles.${role}`) })}
                                aria-invalid={invalid || undefined}
                                value={model}
                                disabled={!saved}
                                placeholder={t("repoRoles.modelPlaceholder")}
                                onChange={(event) => saved && set(role, saved.agent, event.target.value)}
                            />
                            {invalid ? <p className="text-xs text-danger">{t("repoRoles.modelInvalid")}</p> : null}
                        </div>
                    </div>
                );
            })}
        </section>
    );
}
