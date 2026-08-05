"use client";

/**
 * Four cards, in the order the risk goes up: the photo, the profile, the handle,
 * and then the two things only an owner may do.
 *
 * Moving the handle is kept apart from a rename on purpose. A rename changes what
 * the organization is called; moving the handle breaks every link anybody saved,
 * so it is its own deliberate act with its own confirmation naming what stops
 * working.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import type { OrgDetail } from "@/lib/orgs/org-service";
import { useConfirm } from "@/components/confirm-dialog";
import { OrgPhotoCard } from "@/app/(app)/account/avatar-card";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Select, Textarea } from "@polaris/ui";
import {
    changeOrgSlugAction,
    deleteOrgAction,
    transferOrgAction,
    updateOrgAction
} from "@/app/(app)/account/organizations/actions";

export function SettingsView({
    org,
    isOwner,
    candidates,
    impact
}: {
    org: OrgDetail;
    isOwner: boolean;
    candidates: { userId: string; name: string }[];
    impact: { spaces: number; tasks: number };
}) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [error, setError] = useState("");

    const run = async (work: () => Promise<{ error?: string } | null>): Promise<boolean> => {
        setError("");
        const result = await runAction(work, setError);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return false;
        }
        router.refresh();
        return true;
    };

    return (
        <div className="flex flex-col gap-4">
            {error && (
                <p role="alert" className="bg-danger/10 text-danger rounded-md px-3 py-2 text-sm">
                    {error}
                </p>
            )}

            <OrgPhotoCard orgId={org.id} name={org.name} hasPhoto={org.hasPhoto} />
            <ProfileCard org={org} onRun={run} />
            <HandleCard org={org} confirm={confirm} onError={setError} />

            {isOwner && (
                <>
                    <TransferCard org={org} candidates={candidates} confirm={confirm} onRun={run} />
                    <DangerCard org={org} impact={impact} confirm={confirm} onRun={run} />
                </>
            )}
            {confirmElement}
        </div>
    );
}

type Runner = (work: () => Promise<{ error?: string } | null>) => Promise<boolean>;
type Confirm = ReturnType<typeof useConfirm>[0];

function ProfileCard({ org, onRun }: { org: OrgDetail; onRun: Runner }) {
    const [name, setName] = useState(org.name);
    const [description, setDescription] = useState(org.description);

    const parsed = core.organizationProfileSchema.safeParse({ name, description });
    // Dirty means the values differ from what was loaded, not that a field was
    // touched: something edited and put back leaves Save disabled.
    const changed = name !== org.name || description !== org.description;

    return (
        <Card>
            <CardHeader>
                <CardTitle>Profile</CardTitle>
            </CardHeader>
            <CardBody>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (!parsed.success) return;
                        await onRun(() => updateOrgAction(org.id, parsed.data));
                    }}
                >
                    <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                        Name
                        <Input value={name} onChange={(event) => setName(event.target.value)} />
                    </label>
                    <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                        Description
                        <Textarea
                            value={description}
                            rows={2}
                            placeholder="What this organization does"
                            onChange={(event) => setDescription(event.target.value)}
                        />
                    </label>
                    <div className="flex items-center justify-between gap-2">
                        <p className="text-danger text-xs">
                            {changed && !parsed.success ? parsed.error.issues[0]?.message : ""}
                        </p>
                        <Button type="submit" size="sm" disabled={!changed || !parsed.success}>
                            Save
                        </Button>
                    </div>
                </form>
            </CardBody>
        </Card>
    );
}

function HandleCard({
    org,
    confirm,
    onError
}: {
    org: OrgDetail;
    confirm: Confirm;
    onError: (message: string) => void;
}) {
    const router = useRouter();
    const [slug, setSlug] = useState(org.slug);

    const parsed = core.orgSlugField.safeParse(slug);
    const changed = slug !== org.slug;

    return (
        <Card>
            <CardHeader>
                <CardTitle>Handle</CardTitle>
            </CardHeader>
            <CardBody>
                <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={async (event) => {
                        event.preventDefault();
                        if (!parsed.success || !changed) return;
                        const ok = await confirm({
                            title: "Change the handle?",
                            description: `Every link to /account/organizations/${org.slug} stops working. Anything anybody wrote down has to be updated.`,
                            confirmLabel: "Change it"
                        });
                        if (!ok) return;
                        onError("");
                        const result = await runAction(() => changeOrgSlugAction(org.id, slug), onError);
                        if (!result || result.error) {
                            if (result?.error) onError(result.error);
                            return;
                        }
                        // The URL this page lives at has just moved, so the page
                        // has to follow it rather than refresh into a 404.
                        router.replace(`/account/organizations/${result.slug}/settings`);
                    }}
                >
                    <label className="text-muted-foreground flex min-w-48 flex-1 flex-col gap-1 text-xs">
                        Handle
                        <Input value={slug} className="h-9" onChange={(event) => setSlug(event.target.value)} />
                    </label>
                    <Button type="submit" size="sm" variant="secondary" disabled={!changed || !parsed.success}>
                        Change
                    </Button>
                    <p className="text-muted-foreground w-full text-xs">
                        {changed && !parsed.success
                            ? parsed.error.issues[0]?.message
                            : "Links already handed out will stop working."}
                    </p>
                </form>
            </CardBody>
        </Card>
    );
}

function TransferCard({
    org,
    candidates,
    confirm,
    onRun
}: {
    org: OrgDetail;
    candidates: { userId: string; name: string }[];
    confirm: Confirm;
    onRun: Runner;
}) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>Hand it over</CardTitle>
            </CardHeader>
            <CardBody>
                {candidates.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                        Only somebody already on the roster can be given the organization, and nobody else is on it
                        yet.
                    </p>
                ) : (
                    <label className="text-muted-foreground flex max-w-sm flex-col gap-1 text-xs">
                        Hand over to
                        <Select
                            value=""
                            className="h-9"
                            aria-label="New owner"
                            placeholder="Choose somebody"
                            options={candidates.map((member) => ({ value: member.userId, label: member.name }))}
                            onValueChange={async (userId) => {
                                const person = candidates.find((member) => member.userId === userId);
                                const ok = await confirm({
                                    title: `Hand ${org.name} to ${person?.name}?`,
                                    description:
                                        "They become the owner and you stay on as an admin. Only they can undo it.",
                                    confirmLabel: "Hand over"
                                });
                                if (ok) await onRun(() => transferOrgAction(org.id, userId));
                            }}
                        />
                    </label>
                )}
            </CardBody>
        </Card>
    );
}

function DangerCard({
    org,
    impact,
    confirm,
    onRun
}: {
    org: OrgDetail;
    impact: { spaces: number; tasks: number };
    confirm: Confirm;
    onRun: Runner;
}) {
    const router = useRouter();
    const spaces = `${impact.spaces} space${impact.spaces === 1 ? "" : "s"}`;
    const tasks = `${impact.tasks} task${impact.tasks === 1 ? "" : "s"}`;

    return (
        <Card>
            <CardHeader>
                <CardTitle>Delete</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-foreground text-xs">
                    Deleting takes {spaces} and {tasks} with it, along with its teams, roles and domains.
                </p>
                <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                        const ok = await confirm({
                            title: `Delete ${org.name}?`,
                            description: `${spaces} and ${tasks} are deleted with it. This cannot be undone.`,
                            confirmLabel: "Delete",
                            danger: true
                        });
                        if (!ok) return;
                        if (await onRun(() => deleteOrgAction(org.id))) router.push("/account/organizations");
                    }}
                >
                    <Trash2 className="size-4 shrink-0" /> Delete organization
                </Button>
            </CardBody>
        </Card>
    );
}
