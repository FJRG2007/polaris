"use client";

/**
 * The relay server's cloud firewall, step by step, for the provider it runs on.
 *
 * Same shape as `router-steps.tsx`: every value to type is shown as a value, the
 * provider stays a picker because a server's name is only a hint, and each rule
 * says from here whether it works yet, so the page answers once the rule is saved.
 */

import { Button, Select } from "@polaris/ui";
import { ChevronDown, ExternalLink } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useRef, useState } from "react";
import { bold, portText, Value } from "./guide-parts";
import {
    blockedPorts,
    CLOUD_FIREWALLS,
    detectCloud,
    linkState,
    relayFirewallRules,
    ruleState,
    type CloudFirewall,
    type FirewallRuleState
} from "@/lib/backup-access/firewall-guide";
import type { NamespaceKey } from "@/lib/i18n/types";
import type { BackupView } from "@/lib/backup-access/service";

const STATE_TONE: Record<FirewallRuleState, string> = {
    open: "text-success",
    closed: "text-danger",
    unknown: "text-muted-foreground"
};

export function RelayFirewallGuide({
    view,
    busy,
    rechecking,
    onRecheck
}: {
    view: BackupView;
    busy: boolean;
    rechecking: boolean;
    onRecheck: () => void;
}) {
    const t = useTranslations("admin");
    const relay = view.relay;
    const probe = view.probe;
    const server = view.servers.find((entry) => entry.id === view.config.relayTargetId);
    const detected = detectCloud(server?.name ?? null);
    const [cloud, setCloud] = useState<CloudFirewall>(detected);
    // A provider the operator chose outranks the name, as a router's brand does.
    const picked = useRef(false);
    useEffect(() => {
        if (!picked.current) setCloud(detected);
    }, [detected]);

    const rules = relay ? relayFirewallRules(relay.listenPort, relay.tcp, relay.udp) : [];
    const link = linkState(probe);
    const states = rules.map((rule) =>
        ruleState(rule, link, probe?.relayClosed ?? null, probe?.relayUnclear ?? [])
    );
    const [toggled, setToggled] = useState<boolean | null>(null);
    // Open on its own while something is blocked or the relay's problem points
    // here; a choice made here stands.
    const open = toggled ?? (states.includes("closed") || probe?.problem === "relay-unreachable");
    if (!relay) return null;
    const guide = CLOUD_FIREWALLS.find((entry) => entry.id === cloud) ?? CLOUD_FIREWALLS[0];
    const blocked = rules.reduce(
        (sum, rule, index) =>
            sum + blockedPorts(rule, states[index] ?? "unknown", probe?.relayClosed ?? []),
        0
    );

    return (
        <div className="flex flex-col gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className={blocked > 0 ? "text-danger" : "text-muted-foreground"}>
                    {blocked > 0
                        ? t("domains.backup.firewall.blocked", { count: blocked })
                        : t("domains.backup.firewall.noneBlocked")}
                </span>
                <Button size="sm" variant="secondary" disabled={busy} onClick={onRecheck}>
                    {rechecking
                        ? t("domains.backup.firewall.rechecking")
                        : t("domains.backup.firewall.recheck")}
                </Button>
            </div>
            <button
                type="button"
                aria-expanded={open}
                className="flex w-fit items-center gap-1 font-medium text-foreground hover:underline"
                onClick={() => setToggled(!open)}
            >
                <ChevronDown
                    className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
                />
                {open ? t("domains.backup.firewall.hide") : t("domains.backup.firewall.show")}
            </button>
            {!open ? null : (
                <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-end gap-2">
                        <label className="flex min-w-40 flex-1 flex-col gap-1">
                            {t("domains.backup.firewall.provider")}
                            <Select
                                value={cloud}
                                onValueChange={(value) => {
                                    picked.current = true;
                                    setCloud(value as CloudFirewall);
                                }}
                                options={CLOUD_FIREWALLS.map((entry) => ({
                                    value: entry.id,
                                    label: entry.label ?? t("domains.backup.firewall.otherCloud")
                                }))}
                            />
                        </label>
                        {guide.url ? (
                            <Button size="sm" variant="secondary" asChild>
                                <a href={guide.url} target="_blank" rel="noreferrer noopener">
                                    {t("domains.backup.firewall.open", {
                                        provider: guide.label ?? ""
                                    })}{" "}
                                    <ExternalLink className="size-3.5" />
                                </a>
                            </Button>
                        ) : null}
                    </div>
                    <ol className="ml-4 flex list-decimal flex-col gap-2 text-muted-foreground">
                        {Array.from({ length: guide.steps }, (_, index) => (
                            <li key={index}>
                                {t.rich(
                                    `domains.backup.firewall.clouds.${cloud}.step${index + 1}` as NamespaceKey<"admin">,
                                    { address: relay.address, b: bold }
                                )}
                            </li>
                        ))}
                    </ol>
                    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                        {rules.map((rule, index) => {
                            const state = states[index] ?? "unknown";
                            return (
                                <li
                                    key={`${rule.protocol}-${rule.port}`}
                                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                                >
                                    <code className="w-8 text-foreground">{rule.protocol}</code>
                                    <span className="min-w-24">
                                        <Value text={portText(rule)} />
                                    </span>
                                    <span className="min-w-0 flex-1 text-muted-foreground">
                                        {t(`domains.backup.firewall.purposes.${rule.purpose}`)}
                                    </span>
                                    <span className={STATE_TONE[state]}>
                                        {t(`domains.backup.firewall.states.${state}`)}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                    <p className="text-muted-foreground">{t("domains.backup.firewall.after")}</p>
                </div>
            )}
        </div>
    );
}
