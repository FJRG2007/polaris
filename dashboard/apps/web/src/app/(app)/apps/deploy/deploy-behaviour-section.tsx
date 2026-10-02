"use client";

/**
 * What a deploy does to the version already running: a change-over with no gap,
 * or a restart - and then every reason, in words the operator can act on. Beside
 * it the two settings that change it: sharing volumes for the change-over, and
 * the networks of the operator's own the service joins.
 */

import { Plus, Trash2 } from "lucide-react";
import { Button, Input, Switch } from "@polaris/ui";
import { useEffect, useMemo, useState } from "react";
import type { RestartReason } from "@/lib/deploy/releases";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DeployBehaviourView } from "@/lib/deploy/deploy-behaviour";
import { externalNetworksSchema } from "@/lib/deploy/external-networks-schema";
import { deployBehaviourAction, setExternalNetworksAction, setOverlapVolumesAction } from "./deploy-behaviour-actions";

/** One row of the networks form, as typed: the aliases as one comma-separated line. */
interface NetworkRow {
    readonly name: string;
    readonly aliases: string;
}

function rowsOf(view: DeployBehaviourView): NetworkRow[] {
    return view.externalNetworks.map((entry) => ({ name: entry.name, aliases: entry.aliases.join(", ") }));
}

function listOf(rows: readonly NetworkRow[]) {
    return rows.map((row) => ({
        name: row.name,
        aliases: row.aliases
            .split(",")
            .map((alias) => alias.trim())
            .filter(Boolean)
    }));
}

export function DeployBehaviourSection({ applicationId, canConfigure }: { applicationId: string; canConfigure: boolean }) {
    const t = useTranslations("deployService");
    const [view, setView] = useState<DeployBehaviourView | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [rows, setRows] = useState<NetworkRow[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let active = true;
        void deployBehaviourAction(applicationId).then((result) => {
            if (!active) return;
            if (result.view) {
                setView(result.view);
                setRows(rowsOf(result.view));
            } else setLoadError(result.error ?? t("behaviour.loadFailed"));
        });
        return () => {
            active = false;
        };
    }, [applicationId, t]);

    // Checked as it is typed, by the same schema the server saves through. A row
    // still being filled in is incomplete, not wrong: an empty name says nothing.
    const issues = useMemo(() => {
        const found = new Map<string, string>();
        const filled = rows.filter((row) => row.name.trim() !== "");
        const parsed = externalNetworksSchema.safeParse(listOf(filled));
        if (parsed.success) return found;
        for (const issue of parsed.error.issues) {
            const [index, field] = issue.path;
            const key = typeof index === "number" ? `${filled[index]?.name.trim() ?? ""}:${String(field ?? "name")}` : "list";
            if (!found.has(key)) found.set(key, issue.message);
        }
        return found;
    }, [rows]);

    if (loadError) return <p className="text-sm text-danger">{loadError}</p>;
    if (!view) {
        return (
            <section className="flex flex-col gap-2" aria-busy="true">
                <h3 className="text-sm font-medium">{t("behaviour.title")}</h3>
                <div className="h-16 animate-pulse rounded-md bg-muted" />
            </section>
        );
    }

    const saved = JSON.stringify(listOf(rowsOf(view)));
    const typed = listOf(rows.filter((row) => row.name.trim() !== ""));
    const dirty = JSON.stringify(typed) !== saved;
    const incomplete = rows.some((row) => row.name.trim() === "");

    async function toggleOverlap(next: boolean) {
        if (!view) return;
        const before = view;
        setError(null);
        setView({ ...view, overlapVolumes: next });
        const result = await setOverlapVolumesAction(applicationId, next);
        if (result.error) {
            setView(before);
            setError(result.error);
            return;
        }
        // The promise on screen follows the setting; read it again rather than guess.
        const fresh = await deployBehaviourAction(applicationId);
        if (fresh.view) setView(fresh.view);
    }

    async function saveNetworks() {
        if (!view || !dirty || issues.size > 0) return;
        const before = view;
        setSaving(true);
        setError(null);
        setView({ ...view, externalNetworks: externalNetworksSchema.parse(typed) });
        const result = await setExternalNetworksAction(applicationId, typed);
        setSaving(false);
        if (result.error) {
            setView(before);
            setError(result.error);
        } else setRows(typed.map((entry) => ({ name: entry.name, aliases: entry.aliases.join(", ") })));
    }

    const strategy = view.strategy;
    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t("behaviour.title")}</h3>
            <div className="flex flex-col gap-3 rounded-md border border-border p-3 text-sm">
                {strategy.mode === "restart" ? (
                    <div className="flex flex-col gap-1">
                        <p className="font-medium text-warning">{t("behaviour.restart")}</p>
                        <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
                            {strategy.reasons.map((reason, index) => (
                                <li key={index}>{reasonText(reason, t)}</li>
                            ))}
                        </ul>
                    </div>
                ) : (
                    <div className="flex flex-col gap-1">
                        <p className="font-medium text-success">{t("behaviour.noGap")}</p>
                        <p className="text-muted-foreground">{t(`behaviour.mode.${strategy.mode}`)}</p>
                    </div>
                )}

                {view.overlapChoice && (
                    <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
                        <div className="flex min-w-0 flex-col gap-1">
                            <span className="font-medium">{t("behaviour.overlap")}</span>
                            <span className="text-xs text-muted-foreground">{t("behaviour.overlapHint")}</span>
                        </div>
                        <Switch
                            checked={view.overlapVolumes}
                            onChange={(next) => void toggleOverlap(next)}
                            disabled={!canConfigure}
                            aria-label={t("behaviour.overlap")}
                        />
                    </div>
                )}

                <div className="flex flex-col gap-2 border-t border-border pt-3">
                    <span className="font-medium">{t("behaviour.networks")}</span>
                    <span className="text-xs text-muted-foreground">
                        {t("behaviour.networksHint", { name: view.defaultAlias })}
                    </span>
                    {rows.map((row, index) => {
                        const nameIssue = issues.get(`${row.name.trim()}:name`);
                        const aliasIssue = issues.get(`${row.name.trim()}:aliases`);
                        return (
                            <div key={index} className="flex flex-col gap-1">
                                <div className="flex items-center gap-2">
                                    <Input
                                        value={row.name}
                                        onChange={(event) =>
                                            setRows(rows.map((r, at) => (at === index ? { ...r, name: event.target.value } : r)))
                                        }
                                        placeholder="app_network"
                                        className="h-8 w-40 shrink-0"
                                        disabled={!canConfigure}
                                        aria-label={t("behaviour.networkName")}
                                        aria-invalid={nameIssue ? true : undefined}
                                    />
                                    <Input
                                        value={row.aliases}
                                        onChange={(event) =>
                                            setRows(rows.map((r, at) => (at === index ? { ...r, aliases: event.target.value } : r)))
                                        }
                                        placeholder={view.defaultAlias}
                                        className="h-8 min-w-0 flex-1"
                                        disabled={!canConfigure}
                                        aria-label={t("behaviour.networkAliases")}
                                        aria-invalid={aliasIssue ? true : undefined}
                                    />
                                    {canConfigure && (
                                        <button
                                            type="button"
                                            onClick={() => setRows(rows.filter((_, at) => at !== index))}
                                            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                            aria-label={t("behaviour.removeNetwork")}
                                            title={t("behaviour.removeNetwork")}
                                        >
                                            <Trash2 className="size-4" />
                                        </button>
                                    )}
                                </div>
                                {(nameIssue || aliasIssue) && (
                                    <p className="text-xs text-danger">{issueText(nameIssue ?? aliasIssue ?? "", t)}</p>
                                )}
                            </div>
                        );
                    })}
                    {issues.get("list") && <p className="text-xs text-danger">{issueText(issues.get("list") ?? "", t)}</p>}
                    {canConfigure && (
                        <div className="flex items-center justify-between gap-2">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setRows([...rows, { name: "", aliases: "" }])}
                                disabled={rows.length >= 8}
                            >
                                <Plus className="size-4" /> {t("behaviour.addNetwork")}
                            </Button>
                            <Button
                                size="sm"
                                onClick={() => void saveNetworks()}
                                disabled={!dirty || incomplete || issues.size > 0 || saving}
                                aria-disabled={!dirty || incomplete || issues.size > 0 || saving}
                            >
                                {t("behaviour.saveNetworks")}
                            </Button>
                        </div>
                    )}
                </div>
                {error && <p className="text-sm text-danger">{error}</p>}
            </div>
        </section>
    );
}

type T = NamespaceTranslator<"deployService">;

/** One reason a deploy restarts the service, as a sentence that says what to do. */
function reasonText(reason: RestartReason, t: T): string {
    switch (reason.code) {
        case "hostPort":
            return t("behaviour.reason.hostPort", { port: reason.port, protocol: reason.protocol.toUpperCase() });
        case "volumes":
            return t("behaviour.reason.volumes", { names: reason.names.join(", ") });
        case "newVolumes":
            return t("behaviour.reason.newVolumes", { names: reason.names.join(", ") });
        case "compose":
            return t("behaviour.reason.compose");
        case "edge":
            return t("behaviour.reason.edge");
        case "history":
            return t("behaviour.reason.history");
        case "unreadable":
            return t("behaviour.reason.unreadable");
    }
}

/** A schema issue, which the shared schema gives as a key of the server's own
 *  namespace, in this screen's words. */
function issueText(message: string, t: T): string {
    const key = message.replace(/^issues\./, "");
    switch (key) {
        case "networkName":
            return t("behaviour.issue.networkName");
        case "networkReserved":
            return t("behaviour.issue.networkReserved");
        case "networkAlias":
            return t("behaviour.issue.networkAlias");
        case "networkTwice":
            return t("behaviour.issue.networkTwice");
        default:
            return t("behaviour.issue.networkTooMany");
    }
}
