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

import Fuse from "fuse.js";
import * as core from "@polaris/core";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { OrgAvatar } from "@/components/avatar";
import { Building2, Search } from "lucide-react";
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

const CREATION_OPTIONS = core.ORG_CREATION_MODES.map((mode) => ({
    value: mode,
    label: core.ORG_CREATION_LABELS[mode]
}));

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

/** What is living on this deployment right now. */
function OrganizationList({ orgs }: { orgs: OrgRow[] }) {
    const router = useRouter();
    const [query, setQuery] = useState("");

    // Fuzzy, over the rows already here: a handle is half-remembered more often
    // than it is typed correctly, and an owner's name is worth finding by either
    // half of it.
    const fuse = useMemo(
        () =>
            new Fuse(orgs, {
                keys: ["name", "slug", "ownerName"],
                threshold: 0.3,
                ignoreLocation: true
            }),
        [orgs]
    );
    const shown = useMemo(() => {
        const needle = query.trim();
        if (!needle) return orgs;
        return fuse.search(needle).map((hit) => hit.item);
    }, [fuse, orgs, query]);

    // An administrator is answered as the owner of every organization, so the
    // row opens the real thing rather than a read-only copy of half of it.
    const open = (org: OrgRow) => router.push(`/account/organizations/${org.slug}`);

    return (
        <div className="flex flex-col gap-4">
            <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    className="pl-9"
                    placeholder="Search by name, handle or owner"
                    aria-label="Search organizations"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                />
            </div>

            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">Organization</th>
                            <th className="hidden px-3 py-2 font-medium sm:table-cell">Owner</th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">Members</th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">Teams</th>
                            <th className="hidden px-3 py-2 font-medium lg:table-cell">Spaces</th>
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
                                            Nobody has created one yet.
                                        </span>
                                    ) : (
                                        "No organization matches that."
                                    )}
                                </td>
                            </tr>
                        ) : (
                            shown.map((org) => (
                                <tr
                                    key={org.id}
                                    tabIndex={0}
                                    role="button"
                                    aria-label={`Open ${org.name}`}
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
    const router = useRouter();
    // Numbers stay as typed until submit: a half-typed "10" must not be read as
    // a cap of 1 while somebody is still on the first keystroke.
    const [creation, setCreation] = useState<core.OrgCreationMode>(initial.creation);
    const [maxPerUser, setMaxPerUser] = useState(String(initial.maxPerUser));
    const [maxMembers, setMaxMembers] = useState(String(initial.maxMembers));
    const [maxTeams, setMaxTeams] = useState(String(initial.maxTeams));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);

    const draft = { creation, maxPerUser, maxMembers, maxTeams };
    const parsed = core.organizationPolicySchema.safeParse(draft);
    const changed =
        creation !== initial.creation ||
        Number(maxPerUser) !== initial.maxPerUser ||
        Number(maxMembers) !== initial.maxMembers ||
        Number(maxTeams) !== initial.maxTeams;

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
            <span>{Number(value) === 0 ? "No limit." : hint}</span>
        </label>
    );

    return (
        <Card>
            <CardHeader>
                <CardTitle>Policy</CardTitle>
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
                        Who can create an organization
                        <Select
                            value={creation}
                            options={CREATION_OPTIONS}
                            className="h-9 w-64"
                            aria-label="Who can create an organization"
                            onValueChange={(next) => setCreation(next as core.OrgCreationMode)}
                        />
                        <span>{core.ORG_CREATION_HINTS[creation]}</span>
                    </label>

                    <div className="flex flex-wrap gap-6">
                        {limitField(
                            "Organizations per account",
                            maxPerUser,
                            setMaxPerUser,
                            "Counts only the ones they own."
                        )}
                        {limitField(
                            "Members per organization",
                            maxMembers,
                            setMaxMembers,
                            "Includes the owner."
                        )}
                        {limitField(
                            "Teams per organization",
                            maxTeams,
                            setMaxTeams,
                            "Across the organization."
                        )}
                    </div>

                    <p className="text-xs text-muted-foreground">
                        Lowering a limit never removes anybody. An organization already over it
                        keeps everything it has and simply cannot add more.
                    </p>

                    {error && (
                        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                            {error}
                        </p>
                    )}

                    <div className="flex items-center justify-end gap-3">
                        {saved && !changed && (
                            <span className="text-xs text-muted-foreground">Saved</span>
                        )}
                        <Button
                            type="submit"
                            size="sm"
                            disabled={!changed || !parsed.success || saving}
                        >
                            Save
                        </Button>
                    </div>
                </form>
            </CardBody>
        </Card>
    );
}
