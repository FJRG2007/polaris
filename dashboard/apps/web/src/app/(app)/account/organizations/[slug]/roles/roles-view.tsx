"use client";

/**
 * The role editor. One card per role, each holding the whole answer to "what can
 * somebody with this role do here" as a grid grouped the way the organization's
 * own screens are.
 *
 * Save only lights up when the grid differs from what was loaded, so a role you
 * opened, poked at and put back is not a write. Admin is shown but not editable:
 * it holds everything, including permissions a later version of Polaris adds, and
 * narrowing the one role that exists to be unrestricted is how an organization
 * locks itself out of its own settings.
 *
 * Seeing the organization is not in the grid. Everybody on a roster can, by
 * definition - a role that could not would be somebody who belongs here and gets
 * turned away at every door.
 */

import * as core from "@polaris/core";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { IdCard, Plus, Trash2 } from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";
import type { OrgRoleView } from "@/lib/orgs/role-service";
import {
    createOrgRoleAction,
    deleteOrgRoleAction,
    updateOrgRoleAction
} from "@/app/(app)/account/organizations/actions";
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
    Input,
    Textarea
} from "@polaris/ui";

/** Everything a role can be given, minus the one every role already has. */
const GRANTABLE = core.ORG_PERMISSIONS.filter((permission) => permission !== "org.read");

/** The grantable permissions of each area, in the order the areas were declared.
 *  An area whose only entry was `org.read` disappears rather than being drawn
 *  empty. */
const AREAS = core.ORG_PERMISSION_AREAS.map((area) => ({
    area,
    permissions: GRANTABLE.filter((permission) => core.ORG_PERMISSION_META[permission].area === area)
})).filter((group) => group.permissions.length > 0);

function sameSet(held: Set<string>, saved: readonly string[]): boolean {
    const relevant = saved.filter((permission) => permission !== "org.read");
    return held.size === relevant.length && relevant.every((permission) => held.has(permission));
}

export function RolesView({ orgId, orgSlug, roles }: { orgId: string; orgSlug: string; roles: OrgRoleView[] }) {
    const [creating, setCreating] = useState(false);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-foreground text-sm">
                    A role decides what somebody may do across this organization. Who holds which is set under{" "}
                    <a href={`/account/organizations/${orgSlug}/people`} className="hover:text-foreground underline">
                        People
                    </a>
                    .
                </p>
                <Button size="sm" onClick={() => setCreating(true)}>
                    <Plus className="size-4 shrink-0" /> New role
                </Button>
            </div>

            {roles.map((role) => (
                <RoleCard key={role.id} orgId={orgId} role={role} />
            ))}

            <NewRoleDialog orgId={orgId} open={creating} onOpenChange={setCreating} />
        </div>
    );
}

function RoleCard({ orgId, role }: { orgId: string; role: OrgRoleView }) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [held, setHeld] = useState<Set<string>>(
        () => new Set(role.permissions.filter((permission) => permission !== "org.read"))
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const locked = role.slug === core.UNEDITABLE_ORG_ROLE || role.permissions.includes(core.ALL_ORG_PERMISSIONS);
    const dirty = useMemo(() => !sameSet(held, role.permissions), [held, role.permissions]);

    const run = async (work: () => Promise<{ error?: string }>) => {
        setBusy(true);
        const result = await runAction(work, setError);
        setBusy(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        setError("");
        router.refresh();
    };

    return (
        <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <CardTitle className="flex items-center gap-2">
                        <IdCard className="size-4 shrink-0" />
                        {role.name}
                    </CardTitle>
                    <span className="text-muted-foreground text-xs">@{role.slug}</span>
                    {role.system ? <Badge>built-in</Badge> : null}
                    <span className="text-muted-foreground text-xs">
                        {role.memberCount === 1 ? "1 person" : `${role.memberCount} people`}
                    </span>
                </div>
                {!role.system && (
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Delete the ${role.name} role`}
                        title={`Delete the ${role.name} role`}
                        onClick={async () => {
                            const ok = await confirm({
                                title: `Delete the ${role.name} role?`,
                                description:
                                    role.memberCount === 0
                                        ? "Nobody holds it, so nobody loses anything."
                                        : `${role.memberCount} ${
                                              role.memberCount === 1 ? "person becomes" : "people become"
                                          } a Member, and lose whatever this role gave them.`,
                                confirmLabel: "Delete role",
                                danger: true
                            });
                            if (ok) await run(() => deleteOrgRoleAction(orgId, role.slug));
                        }}
                    >
                        <Trash2 className="size-4 shrink-0" />
                    </Button>
                )}
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                {role.description && <p className="text-muted-foreground text-sm">{role.description}</p>}
                {locked ? (
                    <p className="text-muted-foreground text-sm">
                        Holds everything here, including anything a later version of Polaris adds. This is the role
                        that keeps the organization runnable, so it cannot be narrowed.
                    </p>
                ) : (
                    <>
                        <PermissionGrid held={held} disabled={busy} onChange={setHeld} />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-muted-foreground text-xs">
                                {held.size === 0
                                    ? "Sees the organization and whatever their teams reach, and nothing else."
                                    : `${held.size} of ${GRANTABLE.length} permissions.`}
                            </p>
                            <Button
                                size="sm"
                                disabled={busy || !dirty}
                                onClick={() =>
                                    void run(() =>
                                        updateOrgRoleAction(orgId, role.slug, {
                                            name: role.name,
                                            description: role.description,
                                            permissions: [...held]
                                        })
                                    )
                                }
                            >
                                Save
                            </Button>
                        </div>
                    </>
                )}
                {error && (
                    <p role="alert" className="text-danger text-sm">
                        {error}
                    </p>
                )}
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
    held: Set<string>;
    disabled: boolean;
    onChange: (next: Set<string>) => void;
}) {
    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AREAS.map(({ area, permissions }) => (
                <div key={area} className="flex flex-col gap-1.5">
                    <p className="text-muted-foreground text-xs font-medium">{area}</p>
                    {permissions.map((permission) => (
                        <label key={permission} className="flex cursor-pointer items-start gap-2 text-sm">
                            <Checkbox
                                className="mt-0.5"
                                checked={held.has(permission)}
                                disabled={disabled}
                                aria-label={core.ORG_PERMISSION_META[permission].label}
                                onChange={(event) => {
                                    const next = new Set(held);
                                    if (event.target.checked) next.add(permission);
                                    else next.delete(permission);
                                    onChange(next);
                                }}
                            />
                            <span className="min-w-0">{core.ORG_PERMISSION_META[permission].label}</span>
                        </label>
                    ))}
                </div>
            ))}
        </div>
    );
}

function NewRoleDialog({
    orgId,
    open,
    onOpenChange
}: {
    orgId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    const [slugTouched, setSlugTouched] = useState(false);
    const [description, setDescription] = useState("");
    const [held, setHeld] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const parsed = core.orgRoleSchema.safeParse({ name, slug, description, permissions: [...held] });

    const reset = () => {
        setName("");
        setSlug("");
        setSlugTouched(false);
        setDescription("");
        setHeld(new Set());
        setError("");
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) reset();
            }}
        >
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>New role</DialogTitle>
                    <DialogDescription>
                        Name it after the job people actually do here. Everybody who holds it sees the organization;
                        what else it reaches is up to you.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (!parsed.success) return;
                        setBusy(true);
                        const result = await runAction(() => createOrgRoleAction(orgId, parsed.data), setError);
                        setBusy(false);
                        if (!result || result.error) {
                            if (result?.error) setError(result.error);
                            return;
                        }
                        onOpenChange(false);
                        reset();
                        router.refresh();
                    }}
                >
                    <div className="flex flex-wrap gap-3">
                        <label className="text-muted-foreground flex min-w-40 flex-1 flex-col gap-1 text-xs">
                            Name
                            <Input
                                value={name}
                                autoFocus
                                placeholder="Contractor"
                                onChange={(event) => {
                                    setName(event.target.value);
                                    if (!slugTouched) setSlug(core.suggestSlug(event.target.value));
                                }}
                            />
                        </label>
                        <label className="text-muted-foreground flex min-w-40 flex-1 flex-col gap-1 text-xs">
                            Handle
                            <Input
                                value={slug}
                                placeholder="contractor"
                                onChange={(event) => {
                                    setSlugTouched(true);
                                    setSlug(event.target.value);
                                }}
                            />
                        </label>
                    </div>
                    <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                        Description
                        <Textarea
                            value={description}
                            rows={2}
                            placeholder="What somebody with this role is here to do"
                            onChange={(event) => setDescription(event.target.value)}
                        />
                    </label>
                    <PermissionGrid held={held} disabled={busy} onChange={setHeld} />
                    {error && (
                        <p role="alert" className="bg-danger/10 text-danger rounded-md px-3 py-2 text-sm">
                            {error}
                        </p>
                    )}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy || !parsed.success}>
                            Create
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
