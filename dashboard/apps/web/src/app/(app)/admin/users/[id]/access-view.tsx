"use client";

/**
 * The editable half of one person's access, and the explanation underneath it.
 *
 * Each control saves on its own. A single Save over a form this wide would make
 * taking somebody out of a group wait on a role change nobody asked to make - the
 * same reason the account dialog works that way.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { setUserRoleAction } from "../actions";
import { CapabilitiesCard } from "./capabilities-card";
import { useConfirm } from "@/components/confirm-dialog";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AccessExplanation, ResourceGrantView } from "@/lib/access-explain-service";
import { ExternalLink, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Badge, Button, Card, CardBody, Checkbox, Select, Skeleton } from "@polaris/ui";
import {
    removeUserGrantAction,
    setUserGroupAction,
    setUserPolicyAction,
    userAccessAction
} from "./actions";

interface Named {
    id: string;
    name: string;
    description: string | null;
}

export function UserAccessView({
    userId,
    role,
    roles,
    groups,
    memberOf,
    policies,
    attachedPolicies
}: {
    userId: string;
    role: string | null;
    roles: string[];
    groups: Named[];
    memberOf: string[];
    policies: Named[];
    attachedPolicies: string[];
}) {
    const t = useTranslations("admin");
    const router = useRouter();
    const [access, setAccess] = useState<AccessExplanation | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
        void userAccessAction(userId).then((result) => {
            if (result.error) {
                setError(result.error);
                return;
            }
            setError(null);
            setAccess(result.access ?? null);
        });
    }, [userId]);

    useEffect(() => load(), [load]);

    return (
        <div className="flex flex-col gap-4">
            {/* The way back and what this account is are the page's heading now,
                above the name rather than half a screen below it. What is left
                here is the one link that belongs beside the access itself. */}
            <div className="flex flex-wrap items-center gap-2">
                <Link
                    href={`/admin/users?user=${userId}`}
                    className="ml-auto text-sm text-primary hover:underline"
                >
                    {t("usersDetail.accessView.sessionsLink")}
                </Link>
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            <RoleCard userId={userId} role={role} roles={roles} onSaved={load} />
            <CapabilitiesCard userId={userId} onSaved={load} />
            <MembershipCard
                title={t("usersDetail.accessView.groups.title")}
                hint={t("usersDetail.accessView.groups.hint")}
                items={groups}
                selected={memberOf}
                emptyText={t("usersDetail.accessView.groups.empty")}
                manageLabel={t("usersDetail.accessView.groups.manage")}
                manageHref="/admin/groups"
                onToggle={(id, next) => setUserGroupAction(userId, id, next)}
                onSaved={() => {
                    load();
                    router.refresh();
                }}
            />
            <MembershipCard
                title={t("usersDetail.accessView.policies.title")}
                hint={t("usersDetail.accessView.policies.hint")}
                items={policies}
                selected={attachedPolicies}
                emptyText={t("usersDetail.accessView.policies.empty")}
                manageLabel={t("usersDetail.accessView.policies.manage")}
                manageHref="/admin/policies"
                onToggle={(id, next) => setUserPolicyAction(userId, id, next)}
                onSaved={() => {
                    load();
                    router.refresh();
                }}
            />
            <ResourcesCard userId={userId} access={access} onChanged={load} />
        </div>
    );
}

function RoleCard({
    userId,
    role,
    roles,
    onSaved
}: {
    userId: string;
    role: string | null;
    roles: string[];
    onSaved: () => void;
}) {
    const t = useTranslations("admin");
    const router = useRouter();
    const [value, setValue] = useState(role ?? "");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">{t("usersDetail.accessView.role.title")}</h2>
                    <p className="text-sm text-muted-foreground">{t("usersDetail.accessView.role.hint")}</p>
                </div>
                <div className="flex max-w-sm items-center gap-2">
                    <Select
                        value={value}
                        onValueChange={(next) => {
                            setValue(next);
                            setError(null);
                            startTransition(async () => {
                                const result = await setUserRoleAction(userId, next);
                                if (result.error) {
                                    setError(result.error);
                                    setValue(role ?? "");
                                    return;
                                }
                                onSaved();
                                router.refresh();
                            });
                        }}
                        options={roles.map((name) => ({ value: name, label: name }))}
                        disabled={pending}
                        aria-label={t("usersDetail.accessView.role.label")}
                    />
                    {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                </div>
                {error && <p className="text-sm text-danger">{error}</p>}
                <Link href="/admin/roles" className="w-fit text-sm text-primary hover:underline">
                    {t("usersDetail.accessView.role.define")}
                </Link>
            </CardBody>
        </Card>
    );
}

function MembershipCard({
    title,
    hint,
    items,
    selected,
    emptyText,
    manageLabel,
    manageHref,
    onToggle,
    onSaved
}: {
    title: string;
    hint: string;
    items: Named[];
    selected: string[];
    emptyText: string;
    manageLabel: string;
    manageHref: string;
    onToggle: (id: string, next: boolean) => Promise<{ error?: string }>;
    onSaved: () => void;
}) {
    const [checked, setChecked] = useState<string[]>(selected);
    const [error, setError] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    function toggle(id: string) {
        const next = !checked.includes(id);
        // Optimistic: the box moves now and rolls back if the write is refused.
        setChecked((current) => (next ? [...current, id] : current.filter((held) => held !== id)));
        setError(null);
        startTransition(async () => {
            const result = await onToggle(id, next);
            if (result.error) {
                setChecked((current) =>
                    next ? current.filter((held) => held !== id) : [...current, id]
                );
                setError(result.error);
                return;
            }
            onSaved();
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">{title}</h2>
                    <p className="text-sm text-muted-foreground">{hint}</p>
                </div>
                {items.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{emptyText}</p>
                ) : (
                    <div className="flex flex-col gap-2">
                        {items.map((item) => (
                            <label key={item.id} className="flex items-start gap-2 text-sm">
                                <Checkbox
                                    className="mt-0.5"
                                    checked={checked.includes(item.id)}
                                    onChange={() => toggle(item.id)}
                                />
                                <span className="flex flex-col">
                                    <span>{item.name}</span>
                                    {item.description && (
                                        <span className="text-xs text-muted-foreground">
                                            {item.description}
                                        </span>
                                    )}
                                </span>
                            </label>
                        ))}
                    </div>
                )}
                {error && <p className="text-sm text-danger">{error}</p>}
                <Link href={manageHref} className="w-fit text-sm text-primary hover:underline">
                    {manageLabel}
                </Link>
            </CardBody>
        </Card>
    );
}

function ResourcesCard({
    userId,
    access,
    onChanged
}: {
    userId: string;
    access: AccessExplanation | null;
    onChanged: () => void;
}) {
    const t = useTranslations("admin");
    const display = useDisplayFormat();
    const [confirm, confirmElement] = useConfirm();
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    async function remove(grant: ResourceGrantView): Promise<void> {
        setError(null);
        setPending(true);
        try {
            const ok = await confirm({
                title: t("usersDetail.accessView.resources.confirmTitle"),
                description: t("usersDetail.accessView.resources.confirmDescription", { name: grant.resourceLabel }),
                confirmLabel: t("usersDetail.accessView.resources.confirm"),
                danger: true
            });
            if (!ok) return;
            const result = await removeUserGrantAction(
                userId,
                grant.id,
                `${grant.kind}:${grant.resourceId}`
            );
            if (result.error) {
                setError(result.error);
                return;
            }
            onChanged();
        } catch (cause) {
            console.error(cause);
            setError(t("usersDetail.accessView.resources.noAnswer"));
        } finally {
            setPending(false);
        }
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">{t("usersDetail.accessView.resources.title")}</h2>
                    <p className="text-sm text-muted-foreground">{t("usersDetail.accessView.resources.hint")}</p>
                </div>
                {access === null ? (
                    <Skeleton className="h-10 w-full" />
                ) : access.resources.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {t("usersDetail.accessView.resources.empty")}
                    </p>
                ) : (
                    <div className="flex flex-col divide-y divide-border/60">
                        {access.resources.map((grant) => (
                            <div
                                key={grant.id}
                                className="flex items-center justify-between gap-3 py-2"
                            >
                                <div className="flex min-w-0 flex-col gap-0.5">
                                    <div className="flex items-center gap-2">
                                        <span
                                            className="truncate text-sm"
                                            title={grant.resourceLabel}
                                        >
                                            {grant.resourceLabel}
                                        </span>
                                        <Badge>{grant.kindLabel}</Badge>
                                        {grant.effect === "deny" && (
                                            <Badge className="border-danger-edge text-danger">
                                                {t("usersDetail.accessView.resources.deny")}
                                            </Badge>
                                        )}
                                        {grant.expired && (
                                            <Badge className="border-danger-edge text-danger">
                                                {t("usersDetail.accessView.resources.ended")}
                                            </Badge>
                                        )}
                                        {grant.canShare && <Badge>{t("usersDetail.accessView.resources.canShare")}</Badge>}
                                    </div>
                                    <span className="text-xs text-muted-foreground">
                                        {t("usersDetail.accessView.resources.detail", {
                                            actions: grant.actions.join(", "),
                                            via: grant.principalType !== "user" ? "yes" : "no",
                                            principal: grant.principalLabel,
                                            until: grant.expiresAt ? "yes" : "no",
                                            date: grant.expiresAt ? display.date(grant.expiresAt) : ""
                                        })}
                                    </span>
                                </div>
                                <div className="flex items-center gap-1">
                                    {grant.href && (
                                        <Link href={grant.href}>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                aria-label={t("usersDetail.accessView.resources.open", { name: grant.resourceLabel })}
                                                title={t("usersDetail.accessView.resources.open", { name: grant.resourceLabel })}
                                            >
                                                <ExternalLink className="size-4" />
                                            </Button>
                                        </Link>
                                    )}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        disabled={pending}
                                        aria-label={t("usersDetail.accessView.resources.remove", { name: grant.resourceLabel })}
                                        title={t("usersDetail.accessView.resources.remove", { name: grant.resourceLabel })}
                                        onClick={() => void remove(grant)}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                {error && <p className="text-sm text-danger">{error}</p>}
            </CardBody>
            {confirmElement}
        </Card>
    );
}
