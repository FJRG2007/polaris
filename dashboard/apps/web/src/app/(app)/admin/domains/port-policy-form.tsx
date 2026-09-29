"use client";

/**
 * How the router is asked to open game ports, and the ranges Polaris allocates
 * them from.
 *
 * The choice is between doing this once and doing it per server. Under a range,
 * Polaris keeps every game port it hands out inside a declared block, so two
 * rules cover every server that will ever be created here; per port is exact and
 * costs a trip into the router each time. Both read the same blocks, which is why
 * the ranges are editable whichever is picked - they are what the allocator is
 * bounded by, not decoration on the range option.
 *
 * The ranges are typed the way they are displayed and validated as they are
 * typed, against the same parser the action saves with.
 */

import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { savePortPolicyAction } from "./actions";
import { Button, Input, Select } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { describeBlock, parseBlockInput, type PortBlocks, type PortPolicy } from "@/lib/apps/port-block";

/** The catalog key each policy's option and hint live under. */
const POLICY_KEYS = { range: "range", "per-port": "perPort" } as const satisfies Record<PortPolicy, string>;

const POLICIES: readonly PortPolicy[] = ["range", "per-port"];

export function PortPolicyForm({
    policy,
    blocks,
    onSaved
}: {
    policy: PortPolicy;
    blocks: PortBlocks;
    /** Re-read the card this sits in. The ranges decide which ports the advice
     *  above tells the operator to forward, so a save that left them showing the
     *  previous block would be sending somebody to their router for the wrong rule. */
    onSaved: () => void;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [mode, setMode] = useState<PortPolicy>(policy);
    const [tcp, setTcp] = useState(describeBlock(blocks.tcp));
    const [udp, setUdp] = useState(describeBlock(blocks.udp));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const tcpValid = parseBlockInput(tcp) !== null;
    const udpValid = parseBlockInput(udp) !== null;
    const valid = tcpValid && udpValid;
    // Compared against what was loaded rather than against having been touched, so
    // a range edited and put back leaves Save disabled.
    const changed = mode !== policy || tcp !== describeBlock(blocks.tcp) || udp !== describeBlock(blocks.udp);
    const options = POLICIES.map((value) => ({
        value,
        label: t(`domainsPorts.policy.options.${POLICY_KEYS[value]}`)
    }));

    return (
        <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (event) => {
                event.preventDefault();
                if (!valid || !changed) return;
                setBusy(true);
                setError("");
                const result = await runAction(() => savePortPolicyAction({ policy: mode, tcp, udp }), setError);
                setBusy(false);
                if (!result || result.error) {
                    if (result?.error) setError(result.error);
                    return;
                }
                onSaved();
            }}
        >
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                {t("domainsPorts.policy.how")}
                <Select
                    value={mode}
                    options={options}
                    aria-label={t("domainsPorts.policy.howAria")}
                    className="h-9"
                    onValueChange={(next) => setMode(next as PortPolicy)}
                />
            </label>
            <label className="flex w-36 flex-col gap-1 text-xs text-muted-foreground">
                {t("domainsPorts.policy.tcp")}
                <Input
                    value={tcp}
                    className="h-9 font-mono"
                    inputMode="numeric"
                    aria-label={t("domainsPorts.policy.tcpAria")}
                    aria-invalid={!tcpValid}
                    onChange={(event) => setTcp(event.target.value)}
                />
            </label>
            <label className="flex w-36 flex-col gap-1 text-xs text-muted-foreground">
                {t("domainsPorts.policy.udp")}
                <Input
                    value={udp}
                    className="h-9 font-mono"
                    inputMode="numeric"
                    aria-label={t("domainsPorts.policy.udpAria")}
                    aria-invalid={!udpValid}
                    onChange={(event) => setUdp(event.target.value)}
                />
            </label>
            <Button type="submit" size="sm" disabled={busy || !changed || !valid}>
                {tc("actions.save")}
            </Button>
            <p className="w-full text-xs text-muted-foreground">
                {valid ? t(`domainsPorts.policy.hints.${POLICY_KEYS[mode]}`) : t("domainsPorts.policy.invalid")}
            </p>
            {error && (
                <p role="alert" className="w-full text-xs text-danger">
                    {error}
                </p>
            )}
        </form>
    );
}
