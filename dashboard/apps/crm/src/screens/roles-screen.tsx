"use client";

/**
 * What each role of the organization sees and changes in its CRM, per kind of
 * record: every record or only its holder's own, and each field changeable,
 * read-only or hidden. Only somebody who manages the organization's roles
 * reaches the editor; anybody else is told why, in words.
 *
 * The header paints at once; the roles fill in when they arrive.
 */

import { useCrmT } from "./i18n";
import * as model from "../model/roles";
import { unwrap, messageOf } from "./call";
import { ShieldCheck } from "lucide-react";
import * as actions from "../actions/roles";
import { fieldLabel } from "./custom-fields";
import { hostUi } from "@polaris/app-host/client";
import { useCallback, useMemo, useState } from "react";
import { fieldsOf, type FieldDef } from "../model/objects";
import { CRM_OBJECTS, type CrmObject } from "@polaris/core";
import { Button, EmptyState, SegmentedControl, Select, useToast } from "@polaris/ui";

type Access = "change" | "readOnly" | "hidden";

function accessOf(rule: model.ObjectRule, key: string): Access {
    if (rule.hidden.includes(key)) return "hidden";
    return rule.readOnly.includes(key) ? "readOnly" : "change";
}

function withAccess(rule: model.ObjectRule, key: string, access: Access): model.ObjectRule {
    const hidden = rule.hidden.filter((one) => one !== key);
    const readOnly = rule.readOnly.filter((one) => one !== key);
    if (access === "hidden") hidden.push(key);
    if (access === "readOnly") readOnly.push(key);
    return { ...rule, hidden, readOnly };
}

function sameRule(a: model.ObjectRule, b: model.ObjectRule): boolean {
    const set = (list: readonly string[]) => [...list].sort().join("\n");
    return (
        a.rows === b.rows && set(a.hidden) === set(b.hidden) && set(a.readOnly) === set(b.readOnly)
    );
}

export function RolesScreen() {
    const t = useCrmT();
    const toast = useToast();
    const load = useCallback(() => unwrap(() => actions.rolesAction(), t("errors.loadFailed")), [t]);
    const reading = hostUi.liveRead.useLiveRead<actions.RolesOpening>({
        cacheKey: "crm:roles",
        load
    });
    const data = reading.data ?? null;
    const roles = data?.reading?.roles ?? [];
    const [roleSlug, setRoleSlug] = useState<string | null>(null);
    const [object, setObject] = useState<CrmObject>("companies");
    const [drafts, setDrafts] = useState<Record<string, model.ObjectRule>>({});
    const [saved, setSaved] = useState<Record<string, model.ObjectRule>>({});
    const [busy, setBusy] = useState(false);

    const role = roles.find((one) => one.slug === roleSlug) ?? roles.find((one) => !one.full) ?? null;
    const draftKey = role ? `${role.slug}:${object}` : "";
    const stored = role ? (saved[draftKey] ?? role.rules[object]) : model.OPEN_RULE;
    const rule = drafts[draftKey] ?? stored;
    const dirty = Boolean(role) && !sameRule(rule, stored);
    const fields = useMemo<readonly FieldDef[]>(
        () => fieldsOf(object, data?.reading?.fields[object] ?? []),
        [object, data]
    );

    const change = (next: model.ObjectRule) => setDrafts((all) => ({ ...all, [draftKey]: next }));
    const save = async () => {
        if (!role || !dirty) return;
        setBusy(true);
        const key = draftKey;
        try {
            const answer = await unwrap(
                () => actions.saveRoleRuleAction({ role: role.slug, object, ...rule }),
                t("roles.notSaved")
            );
            setSaved((all) => ({ ...all, [key]: answer.rule }));
            setDrafts((all) => {
                const { [key]: _done, ...rest } = all;
                return rest;
            });
            toast.show({ title: t("roles.saved") });
        } catch (caught) {
            toast.show({ title: t("roles.notSaved"), body: messageOf(caught) });
        } finally {
            setBusy(false);
        }
    };

    let body: React.ReactNode;
    if (!data && reading.error) {
        body = <EmptyState icon={<ShieldCheck />} title={t("errors.loadFailed")} description={reading.error} />;
    } else if (!data) {
        body = (
            <div aria-busy="true" aria-label={t("roles.loading")} className="flex flex-col gap-2">
                {Array.from({ length: 6 }, (_, at) => (
                    <div key={at} className="h-10 animate-pulse rounded-md bg-muted" />
                ))}
            </div>
        );
    } else if (!data.orgName) {
        body = <EmptyState icon={<ShieldCheck />} title={t("roles.personal")} />;
    } else if (!data.reading) {
        body = <EmptyState icon={<ShieldCheck />} title={t("roles.forbidden")} />;
    } else {
        body = (
            <div className="flex min-w-0 flex-col gap-4">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Select
                        aria-label={t("roles.title")}
                        value={role?.slug ?? ""}
                        onValueChange={setRoleSlug}
                        options={roles.map((one) => ({
                            value: one.slug,
                            label: one.full ? `${one.name} - ${t("roles.full")}` : one.name,
                            disabled: one.full
                        }))}
                    />
                    <SegmentedControl
                        size="sm"
                        value={object}
                        onValueChange={(value) => setObject(value as CrmObject)}
                        options={CRM_OBJECTS.map((value) => ({
                            value,
                            label: t(`objects.${value}.plural`)
                        }))}
                    />
                </div>
                {role ? (
                    <>
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{t("roles.rows")}</span>
                            <SegmentedControl
                                size="sm"
                                aria-label={t("roles.rows")}
                                value={rule.rows}
                                onValueChange={(rows) => change({ ...rule, rows: rows as model.RowScope })}
                                options={[
                                    { value: "all", label: t("roles.rowsAll") },
                                    { value: "own", label: t("roles.rowsOwn") }
                                ]}
                            />
                            {rule.rows === "own" ? (
                                <span className="text-xs text-muted-foreground">{t("roles.rowsOwnHint")}</span>
                            ) : null}
                        </div>
                        <ul className="flex min-w-0 flex-col divide-y rounded-md border">
                            {fields.map((field) => (
                                <li key={field.key} className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
                                    <span className="min-w-0 flex-1 truncate text-sm" title={fieldLabel(t, object, field)}>
                                        {fieldLabel(t, object, field)}
                                    </span>
                                    {field.primary ? (
                                        <span className="text-xs text-muted-foreground">{t("roles.nameHint")}</span>
                                    ) : (
                                        <SegmentedControl
                                            size="sm"
                                            aria-label={`${t("roles.access")}: ${fieldLabel(t, object, field)}`}
                                            value={accessOf(rule, field.key)}
                                            onValueChange={(access) =>
                                                change(withAccess(rule, field.key, access as Access))
                                            }
                                            options={[
                                                { value: "change", label: t("roles.see") },
                                                { value: "readOnly", label: t("roles.readOnly") },
                                                { value: "hidden", label: t("roles.hidden") }
                                            ]}
                                        />
                                    )}
                                </li>
                            ))}
                        </ul>
                        <div className="flex items-center gap-2">
                            <Button onClick={save} disabled={!dirty || busy}>
                                {t("roles.save")}
                            </Button>
                        </div>
                    </>
                ) : (
                    <EmptyState icon={<ShieldCheck />} title={t("roles.fullHint")} />
                )}
                <p className="text-xs text-muted-foreground">{t("roles.permissions")}</p>
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto overscroll-contain" data-crm-ready>
            <div className="flex min-w-0 flex-col gap-1">
                <h1 className="text-[1.0625rem] font-semibold leading-tight tracking-tight">{t("roles.title")}</h1>
                {data?.orgName ? (
                    <p className="text-sm text-muted-foreground">{t("roles.intro", { org: data.orgName })}</p>
                ) : null}
            </div>
            {body}
        </div>
    );
}
