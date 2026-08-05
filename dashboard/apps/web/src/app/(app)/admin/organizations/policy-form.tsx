"use client";

/**
 * The instance policy for organizations, and what is currently living under it.
 *
 * Turning creation off is the one setting people expect to be destructive and it
 * is not, so the form says so: existing organizations keep working, and the list
 * underneath shows exactly which ones that means. Caps are worded the same way -
 * they gate the next member, never evict the ones already there.
 *
 * A limit of zero is unlimited. The field is a number input, so an empty one has
 * to mean "no cap" rather than "none allowed", and it is labelled that way.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { Building2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
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

export function OrganizationPolicyForm({
    initial,
    orgs,
    save
}: {
    initial: core.OrganizationPolicy;
    orgs: OrgRow[];
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
        <label className="text-muted-foreground flex flex-col gap-1 text-xs">
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
        <div className="flex flex-col gap-4">
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
                        <label className="text-muted-foreground flex flex-col gap-1 text-xs">
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
                            {limitField("Members per organization", maxMembers, setMaxMembers, "Includes the owner.")}
                            {limitField("Teams per organization", maxTeams, setMaxTeams, "Across the organization.")}
                        </div>

                        <p className="text-muted-foreground text-xs">
                            Lowering a limit never removes anybody. An organization already over it keeps everything
                            it has and simply cannot add more.
                        </p>

                        {error && (
                            <p role="alert" className="bg-danger/10 text-danger rounded-md px-3 py-2 text-sm">
                                {error}
                            </p>
                        )}

                        <div className="flex items-center justify-end gap-3">
                            {saved && !changed && <span className="text-muted-foreground text-xs">Saved</span>}
                            <Button type="submit" size="sm" disabled={!changed || !parsed.success || saving}>
                                Save
                            </Button>
                        </div>
                    </form>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>
                        On this deployment
                        <span className="text-muted-foreground ml-2 text-xs font-normal">{orgs.length}</span>
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-1">
                    {orgs.length === 0 ? (
                        <p className="text-muted-foreground flex items-center gap-2 text-sm">
                            <Building2 className="size-4 shrink-0" /> Nobody has created one yet.
                        </p>
                    ) : (
                        orgs.map((org) => (
                            <div key={org.id} className="flex items-center gap-3 rounded-md px-1 py-1.5">
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm" title={org.name}>{org.name}</p>
                                    <p className="text-muted-foreground truncate text-xs">
                                        @{org.slug} - owned by {org.ownerName}
                                    </p>
                                </div>
                                <span className="text-muted-foreground shrink-0 text-xs">
                                    {org.memberCount} member{org.memberCount === 1 ? "" : "s"}, {org.teamCount} team
                                    {org.teamCount === 1 ? "" : "s"}, {org.spaceCount} space
                                    {org.spaceCount === 1 ? "" : "s"}
                                </span>
                            </div>
                        ))
                    )}
                </CardBody>
            </Card>
        </div>
    );
}
