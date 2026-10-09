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
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
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
    DialogFooter,
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
    permissions: GRANTABLE.filter(
        (permission) => core.ORG_PERMISSION_META[permission].area === area
    )
})).filter((group) => group.permissions.length > 0);

/** What each permission is called on screen. Core's own labels are the English
 *  source; the keys here are checked against the catalog by the compiler. */
const PERMISSION_LABELS: Readonly<Record<core.OrgPermission, NamespaceKey<"accountOrgs">>> = {
    "org.read": "roles.permissions.orgRead",
    "settings.manage": "roles.permissions.settingsManage",
    "activity.read": "roles.permissions.activityRead",
    "people.manage": "roles.permissions.peopleManage",
    "teams.manage": "roles.permissions.teamsManage",
    "roles.manage": "roles.permissions.rolesManage",
    "spaces.manage": "roles.permissions.spacesManage",
    "deploy.manage": "roles.permissions.deployManage",
    "domains.manage": "roles.permissions.domainsManage",
    "vault.manage": "roles.permissions.vaultManage",
    "drive.manage": "roles.permissions.driveManage",
    "mail.manage": "roles.permissions.mailManage",
    "crm.companies.edit": "roles.permissions.crmCompaniesEdit",
    "crm.companies.delete": "roles.permissions.crmCompaniesDelete",
    "crm.people.edit": "roles.permissions.crmPeopleEdit",
    "crm.people.delete": "roles.permissions.crmPeopleDelete",
    "crm.opportunities.edit": "roles.permissions.crmOpportunitiesEdit",
    "crm.opportunities.delete": "roles.permissions.crmOpportunitiesDelete"
};

/** The areas the grid is grouped by, by the name core gives them. An area core
 *  adds later is drawn under its own name until it has one here. */
const AREA_LABELS: Readonly<Record<string, NamespaceKey<"accountOrgs">>> = {
    General: "roles.areas.general",
    People: "roles.areas.people",
    Work: "roles.areas.work",
    CRM: "roles.areas.crm"
};

function sameSet(held: Set<string>, saved: readonly string[]): boolean {
    const relevant = saved.filter((permission) => permission !== "org.read");
    return held.size === relevant.length && relevant.every((permission) => held.has(permission));
}

export function RolesView({
    orgId,
    orgSlug,
    roles
}: {
    orgId: string;
    orgSlug: string;
    roles: OrgRoleView[];
}) {
    const t = useTranslations("accountOrgs");
    const [creating, setCreating] = useState(false);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-foreground text-sm">
                    {t.rich("roles.intro", {
                        people: (chunks) => (
                            <a
                                key="people"
                                href={`/account/organizations/${orgSlug}/people`}
                                className="hover:text-foreground underline"
                            >
                                {chunks}
                            </a>
                        )
                    })}
                </p>
                <Button size="sm" onClick={() => setCreating(true)}>
                    <Plus className="size-4 shrink-0" /> {t("roles.new")}
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
    const t = useTranslations("accountOrgs");
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [held, setHeld] = useState<Set<string>>(
        () => new Set(role.permissions.filter((permission) => permission !== "org.read"))
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const locked =
        role.slug === core.UNEDITABLE_ORG_ROLE ||
        role.permissions.includes(core.ALL_ORG_PERMISSIONS);
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
                    {role.system ? <Badge>{t("roles.builtIn")}</Badge> : null}
                    {role.restricted ? <Badge variant="neutral">{t("roles.noImplicitAccess")}</Badge> : null}
                    <span className="text-muted-foreground text-xs">
                        {t("roles.people", { count: role.memberCount })}
                    </span>
                </div>
                {!role.system && (
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={t("roles.deleteLabel", { name: role.name })}
                        title={t("roles.deleteLabel", { name: role.name })}
                        onClick={async () => {
                            const ok = await confirm({
                                title: t("roles.deleteTitle", { name: role.name }),
                                description:
                                    role.memberCount === 0
                                        ? t("roles.deleteNobody")
                                        : t("roles.deleteSome", { count: role.memberCount }),
                                confirmLabel: t("roles.deleteConfirm"),
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
                {role.description && (
                    <p className="text-muted-foreground text-sm">{role.description}</p>
                )}
                {locked ? (
                    <p className="text-muted-foreground text-sm">{t("roles.locked")}</p>
                ) : (
                    <>
                        <PermissionGrid held={held} disabled={busy} onChange={setHeld} />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-muted-foreground text-xs">
                                {role.restricted
                                    ? held.size === 0
                                        ? t("roles.restrictedNone")
                                        : t("roles.restrictedSome", { held: held.size, total: GRANTABLE.length })
                                    : held.size === 0
                                      ? t("roles.plainNone")
                                      : t("roles.plainSome", { held: held.size, total: GRANTABLE.length })}
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
                                {t("form.save")}
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
    const t = useTranslations("accountOrgs");
    const areaLabel = (area: string) => {
        const key = AREA_LABELS[area];
        return key ? t(key) : area;
    };
    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AREAS.map(({ area, permissions }) => (
                <div key={area} className="flex flex-col gap-1.5">
                    <p className="text-muted-foreground text-xs font-medium">{areaLabel(area)}</p>
                    {permissions.map((permission) => (
                        <label
                            key={permission}
                            className="flex cursor-pointer items-start gap-2 text-sm"
                        >
                            <Checkbox
                                className="mt-0.5"
                                checked={held.has(permission)}
                                disabled={disabled}
                                aria-label={t(PERMISSION_LABELS[permission])}
                                onChange={(event) => {
                                    const next = new Set(held);
                                    if (event.target.checked) next.add(permission);
                                    else next.delete(permission);
                                    onChange(next);
                                }}
                            />
                            <span className="min-w-0">
                                {t(PERMISSION_LABELS[permission])}
                            </span>
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
    const t = useTranslations("accountOrgs");
    const router = useRouter();
    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    const [slugTouched, setSlugTouched] = useState(false);
    const [description, setDescription] = useState("");
    const [held, setHeld] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const parsed = core.orgRoleSchema.safeParse({
        name,
        slug,
        description,
        permissions: [...held]
    });

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
                    <DialogTitle>{t("roles.create.title")}</DialogTitle>
                    <DialogDescription>{t("roles.create.body")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (!parsed.success) return;
                        setBusy(true);
                        const result = await runAction(
                            () => createOrgRoleAction(orgId, parsed.data),
                            setError
                        );
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
                            {t("form.name")}
                            <Input
                                value={name}
                                autoFocus
                                placeholder={t("roles.create.namePlaceholder")}
                                onChange={(event) => {
                                    setName(event.target.value);
                                    if (!slugTouched) setSlug(core.suggestSlug(event.target.value));
                                }}
                            />
                        </label>
                        <label className="text-muted-foreground flex min-w-40 flex-1 flex-col gap-1 text-xs">
                            {t("form.handle")}
                            <Input
                                value={slug}
                                placeholder={t("roles.create.handlePlaceholder")}
                                onChange={(event) => {
                                    setSlugTouched(true);
                                    setSlug(event.target.value);
                                }}
                            />
                        </label>
                    </div>
                    <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                        {t("form.description")}
                        <Textarea
                            value={description}
                            rows={2}
                            placeholder={t("roles.create.descriptionPlaceholder")}
                            onChange={(event) => setDescription(event.target.value)}
                        />
                    </label>
                    <PermissionGrid held={held} disabled={busy} onChange={setHeld} />
                    {error && (
                        <p
                            role="alert"
                            className="bg-danger-soft text-danger-ink rounded-md px-3 py-2 text-sm"
                        >
                            {error}
                        </p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {t("form.cancel")}
                        </Button>
                        <Button type="submit" disabled={busy || !parsed.success}>
                            {t("form.create")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
