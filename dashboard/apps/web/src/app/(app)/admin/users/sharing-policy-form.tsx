"use client";

/**
 * Who, besides an administrator, can bring somebody in.
 *
 * It sits on this page because it is the same decision the page is about:
 * registration here is invite-only, and letting the person who runs a server
 * invite their own moderator is a deliberate loosening of that, not a detail of
 * the server. The strict half - creating an account for an address nobody has
 * seen before - is its own step up.
 */

import { useState, useTransition } from "react";
import { setSharingPolicyAction } from "./actions";
import { Button, Card, CardBody, Select } from "@polaris/ui";
import {
    DELEGATED_SHARING_HINTS,
    DELEGATED_SHARING_LABELS,
    DELEGATED_SHARING_MODES,
    type DelegatedSharingMode,
    type SharingPolicy
} from "@polaris/core";

const MODE_OPTIONS = DELEGATED_SHARING_MODES.map((mode) => ({
    value: mode,
    label: DELEGATED_SHARING_LABELS[mode]
}));

export function SharingPolicyForm({
    policy,
    roles
}: {
    policy: SharingPolicy;
    /** Role names this instance defines, for the one a new account is made with. */
    roles: { value: string; label: string }[];
}) {
    const [mode, setMode] = useState<DelegatedSharingMode>(policy.delegated);
    const [inviteRole, setInviteRole] = useState(policy.inviteRole);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [pending, startTransition] = useTransition();

    const dirty = mode !== policy.delegated || inviteRole !== policy.inviteRole;

    function save() {
        setError(null);
        setSaved(false);
        startTransition(async () => {
            const result = await setSharingPolicyAction({ delegated: mode, inviteRole, inviteDays: policy.inviteDays });
            if (result.error) {
                setError(result.error);
                return;
            }
            setSaved(true);
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">Who can invite</h2>
                    <p className="max-w-xl text-sm text-muted-foreground">{DELEGATED_SHARING_HINTS[mode]}</p>
                </div>

                <label className="flex max-w-sm flex-col gap-1 text-sm">
                    <span className="font-medium">Sharing</span>
                    <Select
                        value={mode}
                        onValueChange={(value) => setMode(value as DelegatedSharingMode)}
                        options={MODE_OPTIONS}
                        aria-label="Who can give other people access"
                    />
                </label>

                {mode === "invite" && (
                    <label className="flex max-w-sm flex-col gap-1 text-sm">
                        <span className="font-medium">New accounts get the role</span>
                        <Select
                            value={inviteRole}
                            onValueChange={setInviteRole}
                            options={roles}
                            aria-label="The role an account invited this way is created with"
                        />
                        <span className="text-xs text-muted-foreground">
                            Applies to accounts made this way. guest opens no app on its own, so what they reach is the
                            one thing they were invited to.
                        </span>
                    </label>
                )}

                {error && <p className="text-sm text-danger">{error}</p>}
                {saved && !dirty && <p className="text-sm text-muted-foreground">Saved.</p>}

                <Button className="self-start" size="sm" disabled={!dirty || pending} onClick={save}>
                    Save
                </Button>
            </CardBody>
        </Card>
    );
}
