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
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { saveOwnerDomainPolicyAction } from "./actions";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Select } from "@polaris/ui";
import {
    OWNER_DOMAIN_HINTS,
    OWNER_DOMAIN_LABELS,
    OWNER_DOMAIN_MODES,
    type OwnerDomainMode,
    type OwnerDomainPolicy
} from "@/lib/owner-domains-policy";

const OPTIONS = OWNER_DOMAIN_MODES.map((mode) => ({ value: mode, label: OWNER_DOMAIN_LABELS[mode] }));

export function OwnerDomainsCard({ policy }: { policy: OwnerDomainPolicy }) {
    const router = useRouter();
    const [mode, setMode] = useState<OwnerDomainMode>(policy.mode);
    const [cap, setCap] = useState(String(policy.maxPerOwner));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const parsedCap = Number(cap);
    const capValid = Number.isInteger(parsedCap) && parsedCap >= 0 && parsedCap <= 1000;
    const changed = mode !== policy.mode || parsedCap !== policy.maxPerOwner;

    return (
        <Card>
            <CardHeader>
                <CardTitle>Domains of their own</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-muted-foreground text-sm">
                    An account or an organization can add a domain it owns, prove it with a DNS record, and have its
                    services answer on it. Polaris orders certificates for those hostnames, so this decides who may
                    point a name at this server.
                </p>
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
                        if (!result || result.error) {
                            if (result?.error) setError(result.error);
                            return;
                        }
                        router.refresh();
                    }}
                >
                    <label className="text-muted-foreground flex min-w-48 flex-1 flex-col gap-1 text-xs">
                        Who may add one
                        <Select
                            value={mode}
                            options={OPTIONS}
                            aria-label="Who may add a domain of their own"
                            className="h-9"
                            onValueChange={(next) => setMode(next as OwnerDomainMode)}
                        />
                    </label>
                    <label className="text-muted-foreground flex w-32 flex-col gap-1 text-xs">
                        Limit each to
                        <Input
                            value={cap}
                            inputMode="numeric"
                            className="h-9"
                            aria-label="Domains per owner"
                            onChange={(event) => setCap(event.target.value)}
                        />
                    </label>
                    <Button type="submit" size="sm" disabled={busy || !changed || !capValid}>
                        Save
                    </Button>
                    <p className="text-muted-foreground w-full text-xs">
                        {!capValid ? "Enter a whole number, or 0 for no limit." : OWNER_DOMAIN_HINTS[mode]}
                        {capValid && parsedCap === 0 ? " No limit on how many each may hold." : ""}
                    </p>
                    {error && (
                        <p role="alert" className="text-danger w-full text-xs">
                            {error}
                        </p>
                    )}
                </form>
            </CardBody>
        </Card>
    );
}
