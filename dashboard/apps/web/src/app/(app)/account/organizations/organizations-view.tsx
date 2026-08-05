"use client";

/**
 * The organizations this account is part of, and the dialog that starts one.
 *
 * The handle is the part people get wrong, so it is filled in from the name as
 * they type and stops following once they touch it - typing "Acme Design" and
 * getting `acme-design` is right often enough that asking twice is the annoying
 * part, and somebody who wants a different handle has already told us by editing
 * it.
 */

import Link from "next/link";
import { useState } from "react";
import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { createOrgAction } from "./actions";
import { runAction } from "@/lib/run-action";
import { Building2, Plus, Users } from "lucide-react";
import type { OrgSummary } from "@/lib/orgs/org-service";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Textarea
} from "@polaris/ui";

export function OrganizationsView({
    orgs,
    canCreate,
    blockedReason,
    memberLimit
}: {
    orgs: OrgSummary[];
    canCreate: boolean;
    /** Why the button is not there, in the words the policy uses. */
    blockedReason: string | null;
    /** Roster cap this instance sets, or 0 for none. Shown up front so nobody
     *  builds a plan around a size they cannot reach. */
    memberLimit: number;
}) {
    const router = useRouter();
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    const [slugTouched, setSlugTouched] = useState(false);
    const [description, setDescription] = useState("");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    const parsed = core.organizationSchema.safeParse({ name, slug, description });
    const issue = name || slug ? (parsed.success ? null : parsed.error.issues[0]?.message) : null;

    const reset = () => {
        setName("");
        setSlug("");
        setSlugTouched(false);
        setDescription("");
        setError("");
    };

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!parsed.success) return;
        setSaving(true);
        setError("");
        const result = await runAction(() => createOrgAction(parsed.data), setError);
        setSaving(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        setCreating(false);
        reset();
        router.push(`/account/organizations/${result.slug}`);
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
                <p className="text-muted-foreground text-sm">
                    {orgs.length === 0
                        ? "You are not part of any organization yet."
                        : `${orgs.length} organization${orgs.length === 1 ? "" : "s"}`}
                </p>
                {canCreate ? (
                    <Button size="sm" onClick={() => setCreating(true)}>
                        <Plus className="size-4" /> New organization
                    </Button>
                ) : (
                    <span className="text-muted-foreground text-xs">{blockedReason}</span>
                )}
            </div>

            {orgs.length === 0 ? (
                <Card>
                    <CardBody className="flex flex-col items-center gap-2 py-10 text-center">
                        <Building2 className="text-muted-foreground size-6" />
                        <p className="text-sm">An organization owns spaces on behalf of a group.</p>
                        <p className="text-muted-foreground max-w-sm text-xs">
                            Put people on its roster, group them into teams, and give a team a space. Joining the
                            team is then the only thing anybody has to do to reach the work.
                        </p>
                    </CardBody>
                </Card>
            ) : (
                <ul className="flex flex-col gap-2">
                    {orgs.map((org) => (
                        <li key={org.id}>
                            <Link
                                href={`/account/organizations/${org.slug}`}
                                className="border-border hover:bg-muted flex items-center gap-3 rounded-lg border px-3 py-3 transition-colors"
                            >
                                <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
                                    <Building2 className="text-muted-foreground size-4 shrink-0" />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-2">
                                        <span className="truncate text-sm font-medium" title={org.name}>{org.name}</span>
                                        <Badge variant={org.role === "owner" ? "primary" : "neutral"}>
                                            {org.role === "owner" ? "Owner" : core.ORG_ROLE_LABELS[org.role]}
                                        </Badge>
                                    </span>
                                    <span className="text-muted-foreground block truncate text-xs">
                                        @{org.slug}
                                        {org.description ? ` - ${org.description}` : ""}
                                    </span>
                                </span>
                                <span className="text-muted-foreground hidden shrink-0 items-center gap-3 text-xs sm:flex">
                                    <span className="flex items-center gap-1">
                                        <Users className="size-3.5 shrink-0" /> {org.memberCount}
                                    </span>
                                    <span>
                                        {org.teamCount} team{org.teamCount === 1 ? "" : "s"}
                                    </span>
                                    <span>
                                        {org.spaceCount} space{org.spaceCount === 1 ? "" : "s"}
                                    </span>
                                </span>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}

            <Dialog
                open={creating}
                onOpenChange={(open) => {
                    setCreating(open);
                    if (!open) reset();
                }}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>New organization</DialogTitle>
                        <DialogDescription>
                            You own it. Add people to its roster afterwards and put them on teams.
                            {memberLimit > 0 ? ` This Polaris allows up to ${memberLimit} members.` : ""}
                        </DialogDescription>
                    </DialogHeader>
                    <form className="flex flex-col gap-3" onSubmit={submit}>
                        <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                            Name
                            <Input
                                value={name}
                                autoFocus
                                placeholder="Acme Design"
                                onChange={(event) => {
                                    setName(event.target.value);
                                    if (!slugTouched) setSlug(core.suggestSlug(event.target.value));
                                }}
                            />
                        </label>
                        <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                            Handle
                            <Input
                                value={slug}
                                placeholder="acme-design"
                                onChange={(event) => {
                                    setSlugTouched(true);
                                    setSlug(event.target.value);
                                }}
                            />
                            <span className="text-muted-foreground text-xs">
                                Used in links. Cannot be one an account already signs in with.
                            </span>
                        </label>
                        <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                            Description
                            <Textarea
                                value={description}
                                rows={2}
                                placeholder="What this organization is for"
                                onChange={(event) => setDescription(event.target.value)}
                            />
                        </label>
                        {(issue || error) && (
                            <p role="alert" className="bg-danger/10 text-danger rounded-md px-3 py-2 text-sm">
                                {error || issue}
                            </p>
                        )}
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={!parsed.success || saving}>
                                Create
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </div>
    );
}
