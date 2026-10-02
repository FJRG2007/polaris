"use client";

/**
 * The organizations on this deployment, and the policy they live under.
 *
 * The list is a directory in the same shape as the people one: a search over
 * what is already on the page, one row each, and the row opens the organization
 * itself. It used to be a stack of lines in a card underneath the settings,
 * which put the deployment's actual contents last and made a deployment with
 * twenty organizations unreadable.
 *
 * The policy sits below it for the same reason it does on the people page: an
 * operator arrives to see what exists far more often than to change what may
 * exist, and the setting is read against the list rather than the other way
 * round.
 *
 * Turning creation off is the one setting people expect to be destructive and it
 * is not, so the form says so: existing organizations keep working, and the list
 * above shows exactly which ones that means. Caps are worded the same way - they
 * gate the next member, never evict the ones already there.
 *
 * A limit of zero is unlimited. The field is a number input, so an empty one has
 * to mean "no cap" rather than "none allowed", and it is labelled that way.
 */

import * as core from "@polaris/core";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { OrgAvatar } from "@/components/avatar";
import { Building2, Search } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Select } from "@polaris/ui";

interface OrgRow {
    id: string;
    slug: string;
    name: string;
    ownerName: string;
    memberCount: number;
    teamCount: number;
    spaceCount: number;
}

export function OrganizationsAdmin({
    initial,
    orgs,
    save
}: {
    initial: core.OrganizationPolicy;
    orgs: OrgRow[];
    save: (input: unknown) => Promise<{ error?: string }>;
}) {
    return (
        <div className="flex flex-col gap-4">
            <OrganizationList orgs={orgs} />
            <OrganizationPolicyForm initial={initial} save={save} />
        </div>
    );
}

const ORG_FIELDS: readonly core.SearchField<OrgRow>[] = [
    { text: (org) => org.name },
    { text: (org) => org.slug },
    { text: (org) => org.ownerName }
];

/** What is living on this deployment right now. */
function OrganizationList({ orgs }: { orgs: OrgRow[] }) {
    const t = useTranslations("admin");
    const router = useRouter();
    const [query, setQuery] = useState("");

    // Over the rows already here, by name, handle or owner - an owner's name is
    // worth finding by either half of it.
    const shown = useMemo(
        () =>
            core.searchItems(orgs, query, ORG_FIELDS),
        [orgs, query]
    );

    // An administrator is answered as the owner of every organization, so the
    // row opens the real thing rather than a read-only copy of half of it.
    const open = (org: OrgRow) => router.push(`/account/organizations/${org.slug}`);

    return (
        <div className="flex flex-col gap-4">
            <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    className="pl-9"
                    placeholder={t("organizations.search.placeholder")}
                    aria-label={t("organizations.search.label")}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                />
            </div>

            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">{t("organizations.table.organization")}</th>
                            <th className="hidden px-3 py-2 font-medium sm:table-cell">{t("organizations.table.owner")}</th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">{t("organizations.table.members")}</th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">{t("organizations.table.teams")}</th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">{t("organizations.table.spaces")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.length === 0 ? (
                            <tr>
                                <td
                                    colSpan={5}
                                    className="px-3 py-8 text-center text-muted-foreground"
                                >
                                    {orgs.length === 0 ? (
                                        <span className="flex items-center justify-center gap-2">
                                            <Building2 className="size-4 shrink-0" />
                                            {t("organizations.empty.none")}
                                        </span>
                                    ) : (
                                        t("organizations.empty.noMatch")
                                    )}
                                </td>
                            </tr>
                        ) : (
                            shown.map((org) => (
                                <tr
                                    key={org.id}
                                    tabIndex={0}
                                    role="button"
                                    aria-label={t("organizations.open", { name: org.name })}
                                    onClick={() => open(org)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            open(org);
                                        }
                                    }}
                                    className="cursor-pointer border-t border-border hover:bg-card-hover"
                                >
                                    <td className="px-3 py-2">
                                        <div className="flex items-center gap-3">
                                            <OrgAvatar org={org} size={36} />
                                            <div className="min-w-0">
                                                <p className="truncate font-medium" title={org.name}>
                                                    {org.name}
                                                </p>
                                                <p className="truncate text-xs text-muted-foreground">
                                                    @{org.slug}
                                                </p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                                        <span className="truncate" title={org.ownerName}>{org.ownerName}</span>
                                    </td>
                                    <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                        {org.memberCount}
                                    </td>
                                    <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                        {org.teamCount}
                                    </td>
                                    <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground lg:table-cell">
                                        {org.spaceCount}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/** Whether this deployment offers organizations at all, who may start one, and
 *  how large they may get. */
function OrganizationPolicyForm({
    initial,
    save
}: {
    initial: core.OrganizationPolicy;
    save: (input: unknown) => Promise<{ error?: string }>;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const router = useRouter();
    // Numbers stay as typed until submit: a half-typed "10" must not be read as
    // a cap of 1 while somebody is still on the first keystroke.
    const [creation, setCreation] = useState<core.OrgCreationMode>(initial.creation);
    const [maxPerUser, setMaxPerUser] = useState(String(initial.maxPerUser));
    const [maxMembers, setMaxMembers] = useState(String(initial.maxMembers));
    const [maxTeams, setMaxTeams] = useState(String(initial.maxTeams));
    const [newPeople, setNewPeople] = useState<core.OrgNewPeopleMode>(initial.newPeople);
    const [invitesPerHour, setInvitesPerHour] = useState(String(initial.invitesPerHour));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);

    // A policy stored before a mode existed can carry none; its hint is then
    // whatever the core has for it, as it always was.
    const known = (key: string, fallback: string) => (t.has(key) ? t(key) : fallback);
    const creationOptions = core.ORG_CREATION_MODES.map((mode) => ({
        value: mode,
        label: t(`organizations.creation.options.${mode}`)
    }));
    const newPeopleOptions = core.ORG_NEW_PEOPLE_MODES.map((mode) => ({
        value: mode,
        label: t(`organizations.newPeople.options.${mode}`)
    }));

    const draft = { creation, maxPerUser, maxMembers, maxTeams, newPeople, invitesPerHour };
    const parsed = core.organizationPolicySchema.safeParse(draft);
    const changed =
        creation !== initial.creation ||
        Number(maxPerUser) !== initial.maxPerUser ||
        Number(maxMembers) !== initial.maxMembers ||
        Number(maxTeams) !== initial.maxTeams ||
        newPeople !== initial.newPeople ||
        Number(invitesPerHour) !== initial.invitesPerHour;

    const limitField = (
        label: string,
        value: string,
        set: (next: string) => void,
        hint: string
    ) => (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {label}
            <Input
                type="number"
                min={0}
                value={value}
                className="h-9 w-32"
                onChange={(event) => set(event.target.value)}
            />
            <span>{Number(value) === 0 ? t("organizations.policy.noLimit") : hint}</span>
        </label>
    );

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("organizations.policy.title")}</CardTitle>
            </CardHeader>
            <CardBody>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (!parsed.success) return;
                        setSaving(true);
                        setError("");
                        setSaved(false);
                        const result = await runAction(() => save(parsed.data), setError);
                        setSaving(false);
                        if (!result || result.error) {
                            if (result?.error) setError(result.error);
                            return;
                        }
                        setSaved(true);
                        router.refresh();
                    }}
                >
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        {t("organizations.creation.label")}
                        <Select
                            value={creation}
                            options={creationOptions}
                            className="h-9 w-64"
                            aria-label={t("organizations.creation.label")}
                            onValueChange={(next) => setCreation(next as core.OrgCreationMode)}
                        />
                        <span>
                            {known(
                                `organizations.creation.hints.${creation}`,
                                core.ORG_CREATION_HINTS[creation]
                            )}
                        </span>
                    </label>

                    <div className="flex flex-wrap gap-6">
                        {limitField(
                            t("organizations.limits.perUser.label"),
                            maxPerUser,
                            setMaxPerUser,
                            t("organizations.limits.perUser.hint")
                        )}
                        {limitField(
                            t("organizations.limits.members.label"),
                            maxMembers,
                            setMaxMembers,
                            t("organizations.limits.members.hint")
                        )}
                        {limitField(
                            t("organizations.limits.teams.label"),
                            maxTeams,
                            setMaxTeams,
                            t("organizations.limits.teams.hint")
                        )}
                    </div>

                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        {t("organizations.newPeople.label")}
                        <Select
                            value={newPeople}
                            options={newPeopleOptions}
                            className="h-9 w-72"
                            aria-label={t("organizations.newPeople.label")}
                            onValueChange={(next) => setNewPeople(next as core.OrgNewPeopleMode)}
                        />
                        <span>
                            {known(
                                `organizations.newPeople.hints.${newPeople}`,
                                core.ORG_NEW_PEOPLE_HINTS[newPeople]
                            )}
                        </span>
                    </label>

                    <div className="flex flex-wrap gap-6">
                        {limitField(
                            t("organizations.limits.invites.label"),
                            invitesPerHour,
                            setInvitesPerHour,
                            t("organizations.limits.invites.hint")
                        )}
                    </div>

                    <p className="text-xs text-muted-foreground">{t("organizations.policy.lowering")}</p>

                    {error && (
                        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                            {error}
                        </p>
                    )}

                    <div className="flex items-center justify-end gap-3">
                        {saved && !changed && (
                            <span className="text-xs text-muted-foreground">{t("organizations.policy.saved")}</span>
                        )}
                        <Button
                            type="submit"
                            size="sm"
                            disabled={!changed || !parsed.success || saving}
                        >
                            {tc("actions.save")}
                        </Button>
                    </div>
                </form>
            </CardBody>
        </Card>
    );
}
