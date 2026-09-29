"use client";

/**
 * The roles editor. One card per role, each holding the whole answer to "what can
 * this role do" as a grid of permissions grouped the way the dashboard is.
 *
 * Two behaviours are worth naming. Permissions that imply one another are kept
 * honest as you click - taking "delete files" brings "see files" with it, and
 * dropping "see files" drops everything that cannot stand without it - so a role
 * can never be saved in a shape the evaluator would have to guess about. And Save
 * only lights up when the grid actually differs from what was loaded, so a role
 * you opened, poked at and put back is not a write.
 *
 * "View as" is here rather than on its own screen because this is where the
 * question comes up: you have just decided what a role may do, and the next thing
 * you want is to see it.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, Plus, Trash2 } from "lucide-react";
import type { RoleView } from "@/lib/role-service";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useConfirm } from "@/components/confirm-dialog";
import { viewAsRoleAction } from "@/app/(app)/view-as-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { createRoleAction, deleteRoleAction, setRolePermissionsAction } from "./actions";
import {
    impliedBy,
    PERMISSION_META,
    PERMISSIONS,
    UNEDITABLE_ROLE,
    type Permission
} from "@polaris/core";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

/** The permissions of each area, in the order the areas were declared. */
const AREAS: { area: string; permissions: Permission[] }[] = (() => {
    const grouped = new Map<string, Permission[]>();
    for (const permission of PERMISSIONS) {
        const area = PERMISSION_META[permission].area;
        const list = grouped.get(area);
        if (list) list.push(permission);
        else grouped.set(area, [permission]);
    }
    return [...grouped].map(([area, permissions]) => ({ area, permissions }));
})();

type Translate = NamespaceTranslator<"admin">;

/** An area's name in the reader's language. Keyed by the English name made
 *  camelCase ("Game servers" -> "gameServers"); an area added to the core list
 *  before the catalog knows it keeps its English name rather than a key. */
function areaLabel(t: Translate, area: string): string {
    const key = `roles.areas.${area.toLowerCase().replace(/\s+(\w)/g, (_, next: string) => next.toUpperCase())}`;
    return t.has(key) ? t(key) : area;
}

/** A permission's name in the reader's language, falling back to the core's
 *  English for one the catalog does not know yet. */
function permissionLabel(t: Translate, permission: Permission): string {
    const key = `roles.permissions.${permission}`;
    return t.has(key) ? t(key) : PERMISSION_META[permission].label;
}

/** Everything that cannot be held without `permission`. */
function dependents(permission: Permission): Permission[] {
    return PERMISSIONS.filter((candidate) => impliedBy(candidate).includes(permission));
}

/** Apply one click, carrying implied grants in and dependent grants out. */
function toggle(held: Set<Permission>, permission: Permission, on: boolean): Set<Permission> {
    const next = new Set(held);
    if (on) {
        next.add(permission);
        for (const implied of impliedBy(permission)) next.add(implied);
    } else {
        next.delete(permission);
        for (const dependent of dependents(permission)) next.delete(dependent);
    }
    return next;
}

function sameSet(a: Set<Permission>, b: readonly Permission[]): boolean {
    return a.size === b.length && b.every((permission) => a.has(permission));
}

export function RolesAdmin({ roles }: { roles: RoleView[] }) {
    const t = useTranslations("admin");
    const [creating, setCreating] = useState(false);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex justify-end">
                <Button size="sm" onClick={() => setCreating(true)}>
                    <Plus className="size-4" />
                    {t("roles.newRole")}
                </Button>
            </div>
            {roles.map((role) => (
                <RoleCard key={role.id} role={role} />
            ))}
            {creating ? <NewRoleDialog onOpenChange={setCreating} /> : null}
        </div>
    );
}

function RoleCard({ role }: { role: RoleView }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [held, setHeld] = useState<Set<Permission>>(() => new Set(role.permissions));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const locked = role.wildcard || role.name === UNEDITABLE_ROLE;
    const dirty = useMemo(() => !sameSet(held, role.permissions), [held, role.permissions]);

    async function run(action: () => Promise<{ error?: string }>) {
        setBusy(true);
        setError(null);
        const result = await action();
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return false;
        }
        router.refresh();
        return true;
    }

    async function onDelete() {
        const ok = await confirm({
            title: t("roles.delete.title", { name: role.name }),
            description: t("roles.delete.description"),
            confirmLabel: t("roles.delete.confirm"),
            cancelLabel: tc("actions.cancel"),
            danger: true
        });
        if (ok) await run(() => deleteRoleAction(role.id));
    }

    async function onViewAs() {
        if (await run(() => viewAsRoleAction(role.id))) router.push("/");
    }

    return (
        <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <CardTitle>{role.name}</CardTitle>
                    {role.isSystem ? <Badge>{t("roles.builtIn")}</Badge> : null}
                    <span className="text-xs text-muted-foreground">
                        {t("roles.peopleCount", { count: role.memberCount })}
                    </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("roles.viewAs.label", { name: role.name })}
                        title={t("roles.viewAs.label", { name: role.name })}
                        disabled={busy}
                        onClick={() => void onViewAs()}
                    >
                        <Eye className="size-4" />
                        {t("roles.viewAs.button")}
                    </Button>
                    {role.isSystem ? null : (
                        <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t("roles.delete.label", { name: role.name })}
                            title={t("roles.delete.label", { name: role.name })}
                            disabled={busy}
                            onClick={() => void onDelete()}
                        >
                            <Trash2 className="size-4" />
                        </Button>
                    )}
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                {locked ? (
                    <p className="text-sm text-muted-foreground">{t("roles.locked")}</p>
                ) : (
                    <>
                        <PermissionGrid held={held} disabled={busy} onChange={setHeld} />
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-xs text-muted-foreground">
                                {held.size === 0
                                    ? t("roles.held.none")
                                    : t("roles.held.count", {
                                          held: held.size,
                                          total: PERMISSIONS.length
                                      })}
                            </p>
                            <Button
                                size="sm"
                                disabled={busy || !dirty}
                                onClick={() =>
                                    void run(() =>
                                        setRolePermissionsAction(role.id, {
                                            permissions: [...held]
                                        })
                                    )
                                }
                            >
                                {tc("actions.save")}
                            </Button>
                        </div>
                    </>
                )}
                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
            {confirmElement}
        </Card>
    );
}

function PermissionGrid({
    held,
    disabled,
    onChange
}: {
    held: Set<Permission>;
    disabled: boolean;
    onChange: (next: Set<Permission>) => void;
}) {
    const t = useTranslations("admin");
    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AREAS.map(({ area, permissions }) => (
                <div key={area} className="flex flex-col gap-1.5">
                    <p className="text-xs font-medium text-muted-foreground">{areaLabel(t, area)}</p>
                    {permissions.map((permission) => (
                        <label
                            key={permission}
                            className="flex cursor-pointer items-start gap-2 text-sm"
                        >
                            <Checkbox
                                className="mt-0.5"
                                checked={held.has(permission)}
                                disabled={disabled}
                                aria-label={permissionLabel(t, permission)}
                                onChange={(event) =>
                                    onChange(toggle(held, permission, event.target.checked))
                                }
                            />
                            <span className="min-w-0">{permissionLabel(t, permission)}</span>
                        </label>
                    ))}
                </div>
            ))}
        </div>
    );
}

function NewRoleDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const router = useRouter();
    const [name, setName] = useState("");
    const [held, setHeld] = useState<Set<Permission>>(new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function create() {
        setBusy(true);
        setError(null);
        const result = await createRoleAction({ name, permissions: [...held] });
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
        router.refresh();
    }

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>{t("roles.create.title")}</DialogTitle>
                    <DialogDescription>{t("roles.create.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1">
                        <label className="text-sm" htmlFor="role-name">
                            {t("roles.create.name")}
                        </label>
                        <Input
                            id="role-name"
                            placeholder={t("roles.create.namePlaceholder")}
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </div>
                    <PermissionGrid held={held} disabled={busy} onChange={setHeld} />
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button
                            disabled={busy || name.trim().length === 0}
                            onClick={() => void create()}
                        >
                            {busy ? t("roles.create.creating") : t("roles.create.submit")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
