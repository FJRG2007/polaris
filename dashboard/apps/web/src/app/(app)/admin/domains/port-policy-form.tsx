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
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { savePortPolicyAction } from "./actions";
import { Button, Input, Select } from "@polaris/ui";
import { describeBlock, parseBlockInput, type PortBlocks, type PortPolicy } from "@/lib/apps/port-block";

const OPTIONS: readonly { value: PortPolicy; label: string }[] = [
    { value: "range", label: "One range, opened once" },
    { value: "per-port", label: "One rule per server" }
];

const HINTS: Record<PortPolicy, string> = {
    range: "Two rules cover every server here, now and later. Nothing outside these ranges is opened.",
    "per-port": "Exact, but every new server needs another rule in the router."
};

export function PortPolicyForm({ policy, blocks }: { policy: PortPolicy; blocks: PortBlocks }) {
    const router = useRouter();
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
                router.refresh();
            }}
        >
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                How the router is asked
                <Select
                    value={mode}
                    options={[...OPTIONS]}
                    aria-label="How the router is asked to open game ports"
                    className="h-9"
                    onValueChange={(next) => setMode(next as PortPolicy)}
                />
            </label>
            <label className="flex w-36 flex-col gap-1 text-xs text-muted-foreground">
                TCP range
                <Input
                    value={tcp}
                    className="h-9 font-mono"
                    inputMode="numeric"
                    aria-label="TCP port range"
                    aria-invalid={!tcpValid}
                    onChange={(event) => setTcp(event.target.value)}
                />
            </label>
            <label className="flex w-36 flex-col gap-1 text-xs text-muted-foreground">
                UDP range
                <Input
                    value={udp}
                    className="h-9 font-mono"
                    inputMode="numeric"
                    aria-label="UDP port range"
                    aria-invalid={!udpValid}
                    onChange={(event) => setUdp(event.target.value)}
                />
            </label>
            <Button type="submit" size="sm" disabled={busy || !changed || !valid}>
                Save
            </Button>
            <p className="w-full text-xs text-muted-foreground">
                {valid
                    ? HINTS[mode]
                    : "A range reads like 25565-25664, stays above 1024, and cannot contain 80 or 443."}
            </p>
            {error && (
                <p role="alert" className="w-full text-xs text-danger">
                    {error}
                </p>
            )}
        </form>
    );
}
