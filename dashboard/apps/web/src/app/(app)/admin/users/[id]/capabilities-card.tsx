"use client";

/**
 * Switching one capability on or off for one person.
 *
 * Roles answer "what does somebody like this do", and that is the right question
 * almost always. This is for the exception: one person who needs the chat and
 * whose role does not carry it, one person who must not have it and whose role
 * does. Without it the only way to say that is a new role, which is how an
 * instance ends up with nine of them and nobody able to say what any means.
 *
 * Three states, not a switch. "Follow their role" is a real answer and is not
 * the same as off - an account with no override moves when the role moves, which
 * is the whole point of having roles - so a two-state control would quietly turn
 * every capability into a decision somebody never made the moment they touched
 * one.
 *
 * Grouped by area and starting collapsed on everything except what is already
 * overridden: fifty capabilities is a wall, and the ones that have been changed
 * are the ones somebody came here to see. An area with overrides can hand them
 * all back to the role at once, one existing write per override.
 */

import type { CapabilityState } from "./actions";
import { useCallback, useEffect, useMemo, useState } from "react";
import { setUserPermissionAction, userCapabilitiesAction } from "./actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Checkbox,
    SegmentedControl,
    Skeleton,
    cn
} from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PermissionSections } from "@/components/permission-sections";
import { areaLabel, permissionLabel } from "@/lib/permission-labels";
import { groupByArea, type Section } from "@/lib/permission-sections";

type State = "inherit" | "allow" | "deny";

type Entry = CapabilityState & { readonly id: string };

const isOverridden = (entry: Entry) => entry.override !== null;
const hasOverride = (section: Section<Entry>) => section.items.some(isOverridden);

export function CapabilitiesCard({ userId, onSaved }: { userId: string; onSaved: () => void }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [confirm, confirmElement] = useConfirm();
    const [onlyOverridden, setOnlyOverridden] = useState(false);
    const [capabilities, setCapabilities] = useState<readonly CapabilityState[] | null>(null);
    const [isAdmin, setIsAdmin] = useState(false);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(() => {
        void userCapabilitiesAction(userId).then((result) => {
            if (result.error) {
                setError(result.error);
                return;
            }
            setError("");
            setIsAdmin(result.isAdmin ?? false);
            setCapabilities(result.capabilities ?? []);
        });
    }, [userId]);

    useEffect(load, [load]);

    const sections = useMemo(
        () =>
            groupByArea(capabilities ?? [], (capability) => capability.area).map(
                ([area, entries]): Section<Entry> => ({
                    id: area,
                    label: areaLabel(t, area),
                    items: entries.map((capability) => ({
                        ...capability,
                        id: capability.permission,
                        label: permissionLabel(t, capability.permission)
                    }))
                })
            ),
        [capabilities, t]
    );
    const overriddenTotal = (capabilities ?? []).filter((entry) => entry.override !== null).length;

    const set = async (permission: string, state: State) => {
        setBusy(permission);
        const result = await setUserPermissionAction(userId, permission, state);
        setBusy(null);
        if (result.error) {
            setError(result.error);
            return;
        }
        load();
        onSaved();
    };

    /** Every override in an area handed back to the role, one write each. */
    const resetArea = async (section: Section<Entry>) => {
        const overridden = section.items.filter(isOverridden);
        const ok = await confirm({
            title: t("usersDetail.capabilities.reset.title", { area: section.label }),
            description: t("usersDetail.capabilities.reset.description", {
                count: overridden.length
            }),
            confirmLabel: t("usersDetail.capabilities.reset.confirm"),
            cancelLabel: tc("actions.cancel")
        });
        if (!ok) return;
        setBusy(section.id);
        let failure = "";
        for (const entry of overridden) {
            const result = await setUserPermissionAction(userId, entry.permission, "inherit");
            if (result.error) {
                failure = result.error;
                break;
            }
        }
        setBusy(null);
        setError(failure);
        load();
        onSaved();
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">{t("usersDetail.capabilities.title")}</h2>
                    <p className="mt-1 text-[0.8125rem] text-muted-foreground">
                        {t("usersDetail.capabilities.hint")}
                    </p>
                </div>

                {isAdmin && (
                    <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                        {t("usersDetail.capabilities.admin")}
                    </p>
                )}

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                {capabilities === null ? (
                    <div className="flex flex-col gap-2" aria-hidden="true">
                        {[0, 1, 2].map((row) => (
                            <Skeleton key={row} className="h-8 w-full" />
                        ))}
                    </div>
                ) : (
                    <PermissionSections
                        sections={sections}
                        storageKey="admin.capabilities"
                        startOpen={hasOverride}
                        keep={onlyOverridden ? isOverridden : undefined}
                        toolbar={
                            <label className="flex cursor-pointer items-center gap-2 text-[0.8125rem]">
                                <Checkbox
                                    checked={onlyOverridden}
                                    disabled={overriddenTotal === 0 && !onlyOverridden}
                                    onChange={(event) => setOnlyOverridden(event.target.checked)}
                                />
                                {t("usersDetail.capabilities.onlyOverridden")}
                            </label>
                        }
                        summary={(section) => {
                            const count = section.items.filter(isOverridden).length;
                            return count > 0 ? (
                                <Badge variant="primary">
                                    {t("usersDetail.capabilities.overriddenCount", { count })}
                                </Badge>
                            ) : null;
                        }}
                        trail={(section) =>
                            hasOverride(section) ? (
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    disabled={busy !== null}
                                    onClick={() => void resetArea(section)}
                                >
                                    {t("usersDetail.capabilities.reset.button")}
                                </Button>
                            ) : null
                        }
                        renderItems={(section) => (
                            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                                {section.items.map((capability) => (
                                    <li
                                        key={capability.permission}
                                        className="flex flex-wrap items-center gap-2 px-3 py-2"
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="block break-words text-[0.8125rem]">
                                                {capability.label}
                                            </span>
                                            <span className="block break-all font-mono text-[0.6875rem] text-foreground-subtle">
                                                {capability.permission}
                                            </span>
                                        </span>
                                        <span
                                            className={cn(
                                                "shrink-0 text-[0.6875rem]",
                                                capability.inherited
                                                    ? "text-muted-foreground"
                                                    : "text-foreground-subtle"
                                            )}
                                        >
                                            {capability.inherited
                                                ? t("usersDetail.capabilities.roleAllows")
                                                : t("usersDetail.capabilities.roleDoesNot")}
                                        </span>
                                        <SegmentedControl
                                            size="sm"
                                            value={capability.override ?? "inherit"}
                                            aria-label={t("usersDetail.capabilities.label", {
                                                label: capability.label
                                            })}
                                            onValueChange={(next) =>
                                                void set(capability.permission, next as State)
                                            }
                                            options={[
                                                {
                                                    value: "inherit",
                                                    label: t("usersDetail.capabilities.inherit"),
                                                    title: t(
                                                        "usersDetail.capabilities.inheritTitle"
                                                    ),
                                                    disabled:
                                                        busy === capability.permission ||
                                                        busy === section.id
                                                },
                                                {
                                                    value: "allow",
                                                    label: t("usersDetail.capabilities.allow"),
                                                    title: t("usersDetail.capabilities.allowTitle"),
                                                    disabled:
                                                        busy === capability.permission ||
                                                        busy === section.id
                                                },
                                                {
                                                    value: "deny",
                                                    label: t("usersDetail.capabilities.deny"),
                                                    title: t("usersDetail.capabilities.denyTitle"),
                                                    disabled:
                                                        busy === capability.permission ||
                                                        busy === section.id
                                                }
                                            ]}
                                        />
                                    </li>
                                ))}
                            </ul>
                        )}
                    />
                )}
            </CardBody>
            {confirmElement}
        </Card>
    );
}
