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
import { useConfirm } from "@/components/confirm-dialog";
import { viewAsRoleAction } from "@/app/(app)/view-as-actions";
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
    const [creating, setCreating] = useState(false);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex justify-end">
                <Button size="sm" onClick={() => setCreating(true)}>
                    <Plus className="size-4" />
                    New role
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
            title: `Delete the ${role.name} role?`,
            description: "Nothing holds it, so nobody loses access. It cannot be brought back.",
            confirmLabel: "Delete role",
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
                    {role.isSystem ? <Badge>built-in</Badge> : null}
                    <span className="text-xs text-muted-foreground">
                        {role.memberCount === 1 ? "1 person" : `${role.memberCount} people`}
                    </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`See Polaris as the ${role.name} role`}
                        title={`See Polaris as the ${role.name} role`}
                        disabled={busy}
                        onClick={() => void onViewAs()}
                    >
                        <Eye className="size-4" />
                        View as
                    </Button>
                    {role.isSystem ? null : (
                        <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Delete the ${role.name} role`}
                            title={`Delete the ${role.name} role`}
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
                    <p className="text-sm text-muted-foreground">
                        Holds everything, including permissions added in future versions. This is the role that
                        keeps the instance reachable, so it cannot be narrowed.
                    </p>
                ) : (
                    <>
                        <PermissionGrid held={held} disabled={busy} onChange={setHeld} />
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-xs text-muted-foreground">
                                {held.size === 0
                                    ? "Reaches no app at all - the account exists to be identified, nothing more."
                                    : `${held.size} of ${PERMISSIONS.length} permissions.`}
                            </p>
                            <Button
                                size="sm"
                                disabled={busy || !dirty}
                                onClick={() =>
                                    void run(() => setRolePermissionsAction(role.id, { permissions: [...held] }))
                                }
                            >
                                Save
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
    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AREAS.map(({ area, permissions }) => (
                <div key={area} className="flex flex-col gap-1.5">
                    <p className="text-xs font-medium text-muted-foreground">{area}</p>
                    {permissions.map((permission) => (
                        <label key={permission} className="flex cursor-pointer items-start gap-2 text-sm">
                            <Checkbox
                                className="mt-0.5"
                                checked={held.has(permission)}
                                disabled={disabled}
                                aria-label={PERMISSION_META[permission].label}
                                onChange={(event) => onChange(toggle(held, permission, event.target.checked))}
                            />
                            <span className="min-w-0">{PERMISSION_META[permission].label}</span>
                        </label>
                    ))}
                </div>
            ))}
        </div>
    );
}

function NewRoleDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
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
            <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>New role</DialogTitle>
                    <DialogDescription>
                        A role with nothing ticked is still useful: the account exists and can sign in, but reaches
                        no app.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1">
                        <label className="text-sm" htmlFor="role-name">
                            Name
                        </label>
                        <Input
                            id="role-name"
                            placeholder="contractor"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </div>
                    <PermissionGrid held={held} disabled={busy} onChange={setHeld} />
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button disabled={busy || name.trim().length === 0} onClick={() => void create()}>
                            {busy ? "Creating..." : "Create role"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
