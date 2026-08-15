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
import { ArrowLeft, ExternalLink, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Badge, Button, Card, CardBody, Checkbox, Select, Skeleton } from "@polaris/ui";
import type { AccessExplanation, PermissionVerdict } from "@/lib/access-explain-service";
import { removeUserGrantAction, setUserGroupAction, setUserPolicyAction, userAccessAction } from "./actions";

interface Named {
    id: string;
    name: string;
    description: string | null;
}

export function UserAccessView({
    userId,
    isAdmin,
    banned,
    role,
    roles,
    groups,
    memberOf,
    policies,
    attachedPolicies
}: {
    userId: string;
    isAdmin: boolean;
    banned: boolean;
    role: string | null;
    roles: string[];
    groups: Named[];
    memberOf: string[];
    policies: Named[];
    attachedPolicies: string[];
}) {
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
            <div className="flex flex-wrap items-center gap-2">
                <Link
                    href="/admin/users"
                    className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                    <ArrowLeft className="size-4" /> People
                </Link>
                {isAdmin && <Badge>administrator</Badge>}
                {banned && <Badge className="border-danger/40 text-danger">banned</Badge>}
                <Link
                    href={`/admin/users?user=${userId}`}
                    className="ml-auto text-sm text-primary hover:underline"
                >
                    Sessions, limits and the rest
                </Link>
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            <RoleCard userId={userId} role={role} roles={roles} onSaved={load} />
            <CapabilitiesCard userId={userId} onSaved={load} />
            <MembershipCard
                title="Groups"
                hint="Membership only. What a group may do comes from the policies attached to it."
                items={groups}
                selected={memberOf}
                emptyText="No groups are defined yet."
                manageHref="/admin/groups"
                onToggle={(id, next) => setUserGroupAction(userId, id, next)}
                onSaved={() => {
                    load();
                    router.refresh();
                }}
            />
            <MembershipCard
                title="Policies"
                hint="Attached directly to this account. The documents themselves are written under Policies."
                items={policies}
                selected={attachedPolicies}
                emptyText="No policies are defined yet."
                manageHref="/admin/policies"
                onToggle={(id, next) => setUserPolicyAction(userId, id, next)}
                onSaved={() => {
                    load();
                    router.refresh();
                }}
            />
            <ResourcesCard userId={userId} access={access} onChanged={load} />
            <EffectiveCard access={access} />
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
    const router = useRouter();
    const [value, setValue] = useState(role ?? "");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">Role</h2>
                    <p className="text-sm text-muted-foreground">
                        What they may do across Polaris. One role each, and anything narrower is a policy or access to
                        one particular thing.
                    </p>
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
                        aria-label="Their role"
                    />
                    {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                </div>
                {error && <p className="text-sm text-danger">{error}</p>}
                <Link href="/admin/roles" className="w-fit text-sm text-primary hover:underline">
                    Define what a role holds
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
    manageHref,
    onToggle,
    onSaved
}: {
    title: string;
    hint: string;
    items: Named[];
    selected: string[];
    emptyText: string;
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
                setChecked((current) => (next ? current.filter((held) => held !== id) : [...current, id]));
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
                                        <span className="text-xs text-muted-foreground">{item.description}</span>
                                    )}
                                </span>
                            </label>
                        ))}
                    </div>
                )}
                {error && <p className="text-sm text-danger">{error}</p>}
                <Link href={manageHref} className="w-fit text-sm text-primary hover:underline">
                    Manage {title.toLowerCase()}
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
    const display = useDisplayFormat();
    const [confirm, confirmElement] = useConfirm();
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">On specific things</h2>
                    <p className="text-sm text-muted-foreground">
                        Access to one server, project or space, given outside their role.
                    </p>
                </div>
                {access === null ? (
                    <Skeleton className="h-10 w-full" />
                ) : access.resources.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Nothing. What they reach is whatever their role, groups and policies allow.
                    </p>
                ) : (
                    <div className="flex flex-col divide-y divide-border/60">
                        {access.resources.map((grant) => (
                            <div key={grant.id} className="flex items-center justify-between gap-3 py-2">
                                <div className="flex min-w-0 flex-col gap-0.5">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate text-sm" title={grant.resourceLabel}>{grant.resourceLabel}</span>
                                        <Badge>{grant.kindLabel}</Badge>
                                        {grant.effect === "deny" && (
                                            <Badge className="border-danger/40 text-danger">deny</Badge>
                                        )}
                                        {grant.expired && <Badge className="border-danger/40 text-danger">ended</Badge>}
                                        {grant.canShare && <Badge>can invite others</Badge>}
                                    </div>
                                    <span className="text-xs text-muted-foreground">
                                        {grant.actions.join(", ")}
                                        {grant.principalType !== "user" && ` - via ${grant.principalLabel}`}
                                        {grant.expiresAt && ` - until ${display.date(grant.expiresAt)}`}
                                    </span>
                                </div>
                                <div className="flex items-center gap-1">
                                    {grant.href && (
                                        <Link href={grant.href}>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                aria-label={`Open ${grant.resourceLabel}`}
                                                title={`Open ${grant.resourceLabel}`}
                                            >
                                                <ExternalLink className="size-4" />
                                            </Button>
                                        </Link>
                                    )}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        disabled={pending}
                                        aria-label={`Remove their access to ${grant.resourceLabel}`}
                                        title={`Remove their access to ${grant.resourceLabel}`}
                                        onClick={() =>
                                            startTransition(async () => {
                                                const ok = await confirm({
                                                    title: "Remove this access",
                                                    description: `They lose ${grant.resourceLabel} the next time a page loads. Nothing else about their account changes.`,
                                                    confirmLabel: "Remove",
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
                                            })
                                        }
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

function EffectiveCard({ access }: { access: AccessExplanation | null }) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">Effective permissions</h2>
                    <p className="text-sm text-muted-foreground">
                        What all of the above adds up to, and where each answer comes from.
                    </p>
                </div>
                {access === null ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-2/3" />
                    </div>
                ) : access.isAdmin ? (
                    // Twenty-two green rows would be a lie about where they come
                    // from: an administrator holds them by being one, and holds
                    // whatever a later version adds too.
                    <p className="text-sm">
                        Administrator. Holds every permission, including ones added by future updates, and no policy
                        deny applies to them.
                    </p>
                ) : (
                    <div className="flex flex-col gap-4">
                        {[...new Set(access.global.map((row) => row.area))].map((area) => (
                            <div key={area} className="flex flex-col gap-1">
                                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    {area}
                                </h3>
                                {access.global
                                    .filter((row) => row.area === area)
                                    .map((row) => (
                                        <VerdictRow key={row.permission} verdict={row} />
                                    ))}
                            </div>
                        ))}
                    </div>
                )}
            </CardBody>
        </Card>
    );
}

function VerdictRow({ verdict }: { verdict: PermissionVerdict }) {
    const denied = verdict.reasons.filter((reason) => reason.effect === "deny");
    const allowed = verdict.reasons.filter((reason) => reason.effect === "allow");
    const shown = denied.length > 0 ? denied : allowed;
    return (
        <div className="flex items-baseline justify-between gap-3 py-0.5 text-sm">
            <span className={verdict.allowed ? undefined : "text-muted-foreground"}>{verdict.label}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
                {shown.length === 0
                    ? "Not granted"
                    : shown.map((reason, index) => (
                          <span key={`${reason.label}-${index}`}>
                              {index > 0 && ", "}
                              {reason.effect === "deny" && "Denied by "}
                              {reason.href ? (
                                  <Link href={reason.href} className="hover:underline">
                                      {reason.label}
                                  </Link>
                              ) : (
                                  reason.label
                              )}
                          </span>
                      ))}
            </span>
        </div>
    );
}
