"use client";

/**
 * The organizations on this deployment, and the policy they live under.
 *
 * The list is a directory in the same shape as the people one: a search the
 * server answers, one row each, read a page at a time as it scrolls and drawn a
 * screenful at a time, and the row opens the organization itself. A hosting
 * company that gives every customer an organization has thousands.
 *
 * The policy sits below it for the same reason it does on the people page: an
 * operator arrives to see what exists far more often than to change what may
 * exist, and the setting is read against the list rather than the other way
 * round. That is also why the next page is asked for with a button rather than
 * by scrolling: a list that grows whenever its end comes into view would push
 * the form away every time somebody scrolled down to it.
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
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { OrgAvatar } from "@/components/avatar";
import { Building2, Search } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Select } from "@polaris/ui";
import type { Page } from "@/lib/pagination/cursor";
import type { OrgDirectoryRow } from "@/lib/org-directory";
import { usePagedList } from "@/components/paged-list/use-paged-list";
import { VirtualTableBody } from "@/components/paged-list/virtual-table-body";
import { listOrgDirectoryAction } from "./actions";

type OrgRow = OrgDirectoryRow;

export function OrganizationsAdmin({
    initial,
    first,
    save
}: {
    initial: core.OrganizationPolicy;
    /** The top of the list, unnarrowed, as the server rendered it. */
    first: Page<OrgRow>;
    save: (input: unknown) => Promise<{ error?: string }>;
}) {
    return (
        <div className="flex flex-col gap-4">
            <OrganizationList first={first} />
            <OrganizationPolicyForm initial={initial} save={save} />
        </div>
    );
}

/** How long typing settles before the server is asked. */
const SEARCH_SETTLE_MS = 300;

/** A row's height before it is measured: the avatar and two lines. */
const ROW_ESTIMATE = 57;

const UNNARROWED = { query: "" };

function loadOrgs(cursor: string | null, params: { query: string }, limit?: number) {
    return listOrgDirectoryAction({ cursor, query: params.query, limit });
}

/** What is living on this deployment right now. */
function OrganizationList({ first }: { first: Page<OrgRow> }) {
    const t = useTranslations("admin");
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [search, setSearch] = useState("");

    // By name, handle or owner, asked of the server once typing settles.
    useEffect(() => {
        const timer = setTimeout(() => setSearch(query.trim()), SEARCH_SETTLE_MS);
        return () => clearTimeout(timer);
    }, [query]);
    const list = usePagedList({ first, params: { query: search }, initialParams: UNNARROWED, load: loadOrgs });
    const shown = list.items;

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
                            <th className="w-full max-w-0 px-3 py-2 font-medium">
                                {t("organizations.table.organization")}
                            </th>
                            <th className="hidden px-3 py-2 font-medium sm:table-cell">
                                {t("organizations.table.owner")}
                            </th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">
                                {t("organizations.table.members")}
                            </th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">
                                {t("organizations.table.teams")}
                            </th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">
                                {t("organizations.table.spaces")}
                            </th>
                        </tr>
                    </thead>
                    {shown.length === 0 ? (
                        <tbody>
                            <tr>
                                <td
                                    colSpan={5}
                                    className="px-3 py-8 text-center text-muted-foreground"
                                >
                                    {list.loading ? (
                                        t("users.directory.loading")
                                    ) : list.error ? (
                                        <span className="inline-flex items-center gap-2">
                                            {t("users.directory.loadFailed")}
                                            <Button size="sm" variant="ghost" onClick={list.retry}>
                                                {t("users.directory.retry")}
                                            </Button>
                                        </span>
                                    ) : search ? (
                                        t("organizations.empty.noMatch")
                                    ) : (
                                        <span className="flex items-center justify-center gap-2">
                                            <Building2 className="size-4 shrink-0" />
                                            {t("organizations.empty.none")}
                                        </span>
                                    )}
                                </td>
                            </tr>
                        </tbody>
                    ) : (
                        <VirtualTableBody
                            items={shown}
                            estimate={ROW_ESTIMATE}
                            colSpan={5}
                            getKey={(org) => org.id}
                            footer={
                                list.loading || list.error || list.hasMore ? (
                                    <tr className="border-t border-border">
                                        <td
                                            colSpan={5}
                                            className="px-3 py-3 text-center text-xs text-muted-foreground"
                                        >
                                            {list.error ? (
                                                <span className="inline-flex items-center gap-2">
                                                    {t("users.directory.loadFailed")}
                                                    <Button size="sm" variant="ghost" onClick={list.retry}>
                                                        {t("users.directory.retry")}
                                                    </Button>
                                                </span>
                                            ) : list.loading ? (
                                                t("users.directory.loadingMore")
                                            ) : (
                                                <Button size="sm" variant="ghost" onClick={list.loadMore}>
                                                    {t("organizations.showMore")}
                                                </Button>
                                            )}
                                        </td>
                                    </tr>
                                ) : null
                            }
                            renderRow={(org, row) => (
                                <tr
                                    key={org.id}
                                    {...row}
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
                                    <td className="w-full max-w-0 px-3 py-2">
                                        <div className="flex items-center gap-3">
                                            <OrgAvatar org={org} size={36} />
                                            <div className="min-w-0">
                                                <p
                                                    className="truncate font-medium"
                                                    title={org.name}
                                                >
                                                    {org.name}
                                                </p>
                                                <p className="truncate text-xs text-muted-foreground">
                                                    @{org.slug}
                                                </p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                                        <span className="truncate" title={org.ownerName}>
                                            {org.ownerName}
                                        </span>
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
                            )}
                        />
                    )}
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

                    <p className="text-xs text-muted-foreground">
                        {t("organizations.policy.lowering")}
                    </p>

                    {error && (
                        <p
                            role="alert"
                            className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                        >
                            {error}
                        </p>
                    )}

                    <div className="flex items-center justify-end gap-3">
                        {saved && !changed && (
                            <span className="text-xs text-muted-foreground">
                                {t("organizations.policy.saved")}
                            </span>
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
