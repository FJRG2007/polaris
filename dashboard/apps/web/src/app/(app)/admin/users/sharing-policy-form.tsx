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
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DELEGATED_SHARING_MODES, type DelegatedSharingMode, type SharingPolicy } from "@polaris/core";

export function SharingPolicyForm({
    policy,
    roles
}: {
    policy: SharingPolicy;
    /** Role names this instance defines, for the one a new account is made with. */
    roles: { value: string; label: string }[];
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
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
                    <h2 className="text-sm font-medium">{t("users.sharing.title")}</h2>
                    <p className="max-w-xl text-sm text-muted-foreground">{t(`users.sharing.modes.${mode}.hint`)}</p>
                </div>

                <label className="flex max-w-sm flex-col gap-1 text-sm">
                    <span className="font-medium">{t("users.sharing.label")}</span>
                    <Select
                        value={mode}
                        onValueChange={(value) => setMode(value as DelegatedSharingMode)}
                        options={DELEGATED_SHARING_MODES.map((value) => ({
                            value,
                            label: t(`users.sharing.modes.${value}.label`)
                        }))}
                        aria-label={t("users.sharing.selectLabel")}
                    />
                </label>

                {mode === "invite" && (
                    <label className="flex max-w-sm flex-col gap-1 text-sm">
                        <span className="font-medium">{t("users.sharing.roleLabel")}</span>
                        <Select
                            value={inviteRole}
                            onValueChange={setInviteRole}
                            options={roles}
                            aria-label={t("users.sharing.roleSelectLabel")}
                        />
                        <span className="text-xs text-muted-foreground">{t("users.sharing.roleHint")}</span>
                    </label>
                )}

                {error && <p className="text-sm text-danger">{error}</p>}
                {saved && !dirty && <p className="text-sm text-muted-foreground">{t("users.sharing.saved")}</p>}

                <Button className="self-start" size="sm" disabled={!dirty || pending} onClick={save}>
                    {tc("actions.save")}
                </Button>
            </CardBody>
        </Card>
    );
}
