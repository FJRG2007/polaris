"use client";

/**
 * Whether the people using this Polaris may bring domains of their own.
 *
 * Its own card rather than a line in the wizard because it is a different
 * decision entirely: everything else on this page is about the address Polaris
 * answers on, and this is about what other people are allowed to point at the box.
 * On a home instance it is harmless and useful; on one handing out accounts it is
 * a door, so it says what it opens rather than being a switch labelled "allow".
 */

import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { saveOwnerDomainPolicyAction } from "./actions";
import { Button, Input, Select } from "@polaris/ui";
import { PageSection } from "@/components/page-section";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { OWNER_DOMAIN_MODES, type OwnerDomainMode, type OwnerDomainPolicy } from "@/lib/owner-domains-policy";

export function OwnerDomainsCard({
    policy,
    onSaved
}: {
    policy: OwnerDomainPolicy;
    /** What was stored, so the panel around this holds one copy of it. Saving used
     *  to re-render the page from the server; the page reads its own data now, and
     *  a Save that only wrote would leave the form comparing against the old value
     *  and reading as unsaved. */
    onSaved: (next: OwnerDomainPolicy) => void;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [mode, setMode] = useState<OwnerDomainMode>(policy.mode);
    const [cap, setCap] = useState(String(policy.maxPerOwner));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const parsedCap = Number(cap);
    const capValid = Number.isInteger(parsedCap) && parsedCap >= 0 && parsedCap <= 1000;
    const changed = mode !== policy.mode || parsedCap !== policy.maxPerOwner;
    const options = OWNER_DOMAIN_MODES.map((value) => ({ value, label: t(`domains.owner.modes.${value}`) }));

    return (
        <PageSection
            title={t("domains.owner.title")}
            description={t("domains.owner.description")}
        >
            <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={async (event) => {
                    event.preventDefault();
                    if (!capValid) return;
                    setBusy(true);
                    setError("");
                    const result = await runAction(
                        () => saveOwnerDomainPolicyAction({ mode, maxPerOwner: parsedCap }),
                        setError
                    );
                    setBusy(false);
                    if (!result?.policy || result.error) {
                        if (result?.error) setError(result.error);
                        return;
                    }
                    onSaved(result.policy);
                }}
            >
                <label className="text-muted-foreground flex min-w-48 flex-1 flex-col gap-1 text-xs">
                    {t("domains.owner.who")}
                    <Select
                        value={mode}
                        options={options}
                        aria-label={t("domains.owner.whoAria")}
                        className="h-9"
                        onValueChange={(next) => setMode(next as OwnerDomainMode)}
                    />
                </label>
                <label className="text-muted-foreground flex w-32 flex-col gap-1 text-xs">
                    {t("domains.owner.limit")}
                    <Input
                        value={cap}
                        inputMode="numeric"
                        className="h-9"
                        aria-label={t("domains.owner.limitAria")}
                        onChange={(event) => setCap(event.target.value)}
                    />
                </label>
                <Button type="submit" size="sm" disabled={busy || !changed || !capValid}>
                    {tc("actions.save")}
                </Button>
                <p className="text-muted-foreground w-full text-xs">
                    {!capValid ? t("domains.owner.invalidCap") : t(`domains.owner.hints.${mode}`)}
                    {capValid && parsedCap === 0 ? ` ${t("domains.owner.noLimit")}` : ""}
                </p>
                {error && (
                    <p role="alert" className="text-danger w-full text-xs">
                        {error}
                    </p>
                )}
            </form>
        </PageSection>
    );
}
