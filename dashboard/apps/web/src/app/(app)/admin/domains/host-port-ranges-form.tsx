"use client";

/**
 * One host's own game port ranges, for a machine that outgrows the shared block.
 *
 * A host with nothing set allocates from the shared block above; one with ranges
 * of its own allocates only from them, walking each in order. The ranges are
 * typed the way they read in a router ("25565-25664, 30000-30999") and checked
 * with the same parser the save uses, so overlap is caught while typing.
 */

import { useEffect, useState } from "react";
import { Button, Input } from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DeployTargetPicker } from "@/components/deploy-target-picker";
import { readHostPortRangesAction, saveHostPortRangesAction } from "./actions";
import { describeRanges, parseRangesInput, PORT_RANGES_MAX, type PortRanges } from "@/lib/apps/port-block";

export function HostPortRangesForm() {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [targetId, setTargetId] = useState<string | null>(null);
    const [saved, setSaved] = useState<PortRanges | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [tcp, setTcp] = useState("");
    const [udp, setUdp] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!targetId) return;
        let live = true;
        setLoaded(false);
        setError("");
        void runAction(() => readHostPortRangesAction(targetId), setError).then((result) => {
            if (!live || !result) return;
            if (result.error) {
                setError(result.error);
                return;
            }
            const ranges = result.ranges ?? null;
            setSaved(ranges);
            setTcp(ranges ? describeRanges(ranges.tcp) : "");
            setUdp(ranges ? describeRanges(ranges.udp) : "");
            setLoaded(true);
        });
        return () => {
            live = false;
        };
    }, [targetId]);

    const tcpValid = parseRangesInput(tcp) !== null;
    const udpValid = parseRangesInput(udp) !== null;
    const changed =
        tcp !== (saved ? describeRanges(saved.tcp) : "") || udp !== (saved ? describeRanges(saved.udp) : "");
    // An emptied pair of fields is not invalid, just unfinished: no red until typed.
    const showTcp = tcp === "" || tcpValid;
    const showUdp = udp === "" || udpValid;

    const save = async (reset: boolean) => {
        if (!targetId) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () => saveHostPortRangesAction(reset ? { targetId, reset: true } : { targetId, tcp, udp }),
            setError
        );
        setBusy(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        const ranges = result.ranges ?? null;
        setSaved(ranges);
        setTcp(ranges ? describeRanges(ranges.tcp) : "");
        setUdp(ranges ? describeRanges(ranges.udp) : "");
    };

    return (
        <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                if (tcpValid && udpValid && changed) void save(false);
            }}
        >
            <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                    {t("domainsPorts.hosts.host")}
                    <DeployTargetPicker
                        scope="mine"
                        value={targetId}
                        className="h-9"
                        placeholder={t("domainsPorts.hosts.pick")}
                        aria-label={t("domainsPorts.hosts.host")}
                        onValueChange={(id) => setTargetId(id)}
                    />
                </label>
                <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                    {t("domainsPorts.policy.tcp")}
                    <Input
                        value={tcp}
                        className="h-9 font-mono"
                        disabled={!loaded}
                        placeholder="25565-25664, 30000-30999"
                        aria-label={t("domainsPorts.hosts.tcpAria")}
                        aria-invalid={!showTcp}
                        onChange={(event) => setTcp(event.target.value)}
                    />
                </label>
                <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                    {t("domainsPorts.policy.udp")}
                    <Input
                        value={udp}
                        className="h-9 font-mono"
                        disabled={!loaded}
                        placeholder="19132-19231"
                        aria-label={t("domainsPorts.hosts.udpAria")}
                        aria-invalid={!showUdp}
                        onChange={(event) => setUdp(event.target.value)}
                    />
                </label>
                <Button type="submit" size="sm" disabled={busy || !loaded || !changed || !tcpValid || !udpValid}>
                    {tc("actions.save")}
                </Button>
                {saved ? (
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save(true)}>
                        {t("domainsPorts.hosts.reset")}
                    </Button>
                ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
                {showTcp && showUdp
                    ? t(saved ? "domainsPorts.hosts.own" : "domainsPorts.hosts.shared", { max: PORT_RANGES_MAX })
                    : t("domainsPorts.hosts.invalidHint", { max: PORT_RANGES_MAX })}
            </p>
            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : null}
        </form>
    );
}
