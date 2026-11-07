"use client";

/**
 * Whether devices get through to a node, on the administrator's list: the last
 * known answer at once, a fresh check as the list opens, and when nothing gets
 * through, the one rule to add and where - the hosting provider's firewall or a
 * forward on the operator's own router - with the same guides Management uses
 * for its own ports. Only drawn under /admin, whose messages it borrows.
 */

import * as ui from "@polaris/ui";
import { ChevronDown } from "lucide-react";
import * as actions from "./connect-actions";
import * as reach from "@/lib/vpn/node-reach";
import { useCallback, useEffect, useState } from "react";
import { Value } from "@/app/(app)/admin/domains/guide-parts";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { RouterSteps } from "@/app/(app)/admin/domains/router-steps";
import { CloudFirewallSteps } from "@/app/(app)/admin/domains/cloud-firewall-steps";

type NodeRow = actions.NodesAnswer["nodes"][number];

const TONE: Record<reach.NodeReach, string> = {
    reachable: "text-success",
    blocked: "text-danger",
    unknown: "text-muted-foreground",
    unchecked: "text-muted-foreground"
};

export function NodeReachStatus({ node }: { node: NodeRow }) {
    const t = useTranslations("vpn");
    const [live, setLive] = useState<{ verdict: string; checkedAt: string } | null>(null);
    const [checking, setChecking] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const [toggled, setToggled] = useState<boolean | null>(null);
    const [place, setPlace] = useState<reach.FirewallPlace>(() =>
        reach.firewallPlace(node.host.name, node.host.address)
    );

    const check = useCallback(() => {
        let current = true;
        setChecking(true);
        setFailed(null);
        actions
            .checkVpnNodeReachAction(node.id)
            .then((answer) => {
                if (!current) return;
                if (answer.error !== undefined) setFailed(answer.error);
                else setLive({ verdict: answer.check.verdict, checkedAt: answer.checkedAt });
            })
            .catch(() => current && setFailed(t("errors.generic")))
            .finally(() => current && setChecking(false));
        return () => {
            current = false;
        };
    }, [node.id, t]);

    const ready = node.publicKey !== null;
    // Asked again each time the list opens; the last answer stands meanwhile.
    useEffect(() => (ready ? check() : undefined), [ready, check]);
    if (!ready) return null;

    const state = reach.nodeReach(
        live?.verdict ?? node.reachVerdict,
        live?.checkedAt ?? node.reachCheckedAt,
        new Date()
    );
    const open = toggled ?? state === "blocked";
    const rule = reach.nodeFirewallRule(node.endpoint, node.port);

    return (
        <div className="flex w-full min-w-0 flex-col gap-2 text-xs">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 truncate text-muted-foreground">
                    {t("nodes.reach.label", { port: node.port, address: node.endpoint })}
                </span>
                <span className={TONE[state]} aria-live="polite">
                    {checking && state === "unchecked"
                        ? t("nodes.reach.checking")
                        : t(`nodes.reach.states.${state}`)}
                </span>
                <ui.Button size="sm" variant="ghost" disabled={checking} onClick={check}>
                    {t("nodes.reach.recheck")}
                </ui.Button>
                {state === "blocked" ? (
                    <button
                        type="button"
                        aria-expanded={open}
                        className="flex items-center gap-1 font-medium text-foreground hover:underline"
                        onClick={() => setToggled(!open)}
                    >
                        <ChevronDown
                            className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
                        />
                        {open ? t("nodes.reach.hide") : t("nodes.reach.show")}
                    </button>
                ) : null}
            </div>
            {failed ? <p className="text-danger">{failed}</p> : null}
            {state === "unknown" ? (
                <p className="text-muted-foreground">{t("nodes.reach.unknownHint")}</p>
            ) : null}
            {state !== "blocked" || !open ? null : (
                <div className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-3">
                    <p className="text-muted-foreground">{t("nodes.reach.blockedHint")}</p>
                    {reach.blockedIsCertain(node.host.address) ? null : (
                        <p className="text-muted-foreground">{t("nodes.reach.viaRouter")}</p>
                    )}
                    <label className="flex max-w-xs flex-col gap-1">
                        {t("nodes.reach.where")}
                        <ui.Select
                            value={place}
                            onValueChange={(value) => setPlace(value as reach.FirewallPlace)}
                            options={(["cloud", "router"] as const).map((value) => ({
                                value,
                                label: t(`nodes.reach.places.${value}`)
                            }))}
                        />
                    </label>
                    {place === "router" ? (
                        <RouterSteps
                            server={null}
                            lanIp={
                                reach.blockedIsCertain(node.host.address) ? null : node.host.address
                            }
                            rules={[{ name: "polaris-vpn", protocol: rule.protocol, port: rule.port }]}
                        />
                    ) : (
                        <>
                            <CloudFirewallSteps
                                serverName={node.host.name}
                                address={rule.destination}
                            />
                            <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border px-3 py-2">
                                <dt className="text-muted-foreground">{t("nodes.reach.rule.protocol")}</dt>
                                <dd>
                                    <code className="text-foreground">{rule.protocol}</code>
                                </dd>
                                <dt className="text-muted-foreground">{t("nodes.reach.rule.port")}</dt>
                                <dd>
                                    <Value text={String(rule.port)} />
                                </dd>
                                <dt className="text-muted-foreground">{t("nodes.reach.rule.source")}</dt>
                                <dd className="text-foreground">{t("nodes.reach.rule.any")}</dd>
                                <dt className="text-muted-foreground">
                                    {t("nodes.reach.rule.destination")}
                                </dt>
                                <dd className="min-w-0 truncate">
                                    <Value text={rule.destination} />
                                </dd>
                            </dl>
                        </>
                    )}
                    <p className="text-muted-foreground">{t("nodes.reach.after")}</p>
                </div>
            )}
        </div>
    );
}
