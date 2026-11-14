"use client";

/**
 * Settings of the alert nodes: "When an alert arrives" (its address, made and
 * reset here, the secret shown once) and "Notify about the alert" (severity,
 * push and, on an organization's automation, its people and teams).
 */

import * as core from "@polaris/core";
import { useAppUrl } from "@/components/app-url";
import { CodeView } from "@/components/json-view";
import { RefInput, RefTextarea } from "./references";
import { alertSnippets } from "@/lib/alerts/snippets";
import { RelativeTime } from "@/components/relative-time";
import type { AddressView } from "@/lib/alerts/addresses";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AutomationDetail } from "@/lib/automations/service";
import { alertAddressAction, issueAlertAddressAction } from "../actions";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import { alertAudienceAction, alertPeopleAction, type AlertAudience } from "../alert-actions";
import {
    Button,
    Checkbox,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";

type Config = Record<string, unknown>;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block min-w-0 space-y-1 text-sm">
            <span>{label}</span>
            {children}
        </label>
    );
}

function useSeverities(from = 1) {
    const t = useTranslations("automations");
    return core.ALERT_PRIORITIES.filter((value) => value >= from).map((value) => ({
        value: String(value),
        label: t(`fields.alertSeverities.${value}`)
    }));
}

/** "When an alert arrives": its default severity and its address. */
export function AlertInFields({
    nodeId,
    config,
    set,
    detail
}: {
    nodeId: string;
    config: Config;
    set: (change: Config) => void;
    detail: AutomationDetail;
}) {
    const t = useTranslations("automations");
    const base = useAppUrl();
    const severities = useSeverities();
    const addressId = typeof config.addressId === "string" ? config.addressId : "";
    const priority = typeof config.defaultPriority === "number" ? config.defaultPriority : 3;
    // undefined while it loads; null when the node has none (or it is another node's).
    const [address, setAddress] = useState<AddressView | null | undefined>(addressId ? undefined : null);
    const [secret, setSecret] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, start] = useTransition();

    useEffect(() => {
        if (!addressId) {
            setAddress(null);
            return;
        }
        let live = true;
        void alertAddressAction(detail.id, nodeId, addressId).then((result) => {
            if (live) setAddress(result.ok ? result.address : null);
        });
        return () => {
            live = false;
        };
    }, [detail.id, nodeId, addressId]);

    const issue = () =>
        start(async () => {
            setError(null);
            const result = await issueAlertAddressAction(detail.id, nodeId);
            setConfirming(false);
            if (!result.ok) {
                setError(result.error);
                return;
            }
            setAddress(result.address);
            setSecret(result.secret);
            if (result.address.id !== addressId) set({ addressId: result.address.id });
        });

    const masked = address ? `${base}/api/alerts/${address.id}/...${address.tail}` : "";
    return (
        <div className="space-y-3">
            <Field label={t("alertIn.severity")}>
                <Select
                    value={String(priority)}
                    onValueChange={(value) => set({ defaultPriority: Number(value) })}
                    options={severities}
                    aria-label={t("alertIn.severity")}
                />
            </Field>
            <div className="min-w-0 space-y-2 text-sm">
                <span>{t("alertIn.address")}</span>
                {address === undefined ? (
                    <Skeleton className="h-9 w-full" />
                ) : address === null ? (
                    <p className="text-xs text-muted-foreground">{t("alertIn.none")}</p>
                ) : (
                    <>
                        <Input
                            readOnly
                            value={masked}
                            title={masked}
                            className="min-w-0 font-mono text-xs"
                            aria-label={t("alertIn.address")}
                        />
                        <p className="text-xs text-muted-foreground">
                            {address.lastUsedAt ? (
                                <>
                                    {t("alertIn.lastUsed")} <RelativeTime iso={address.lastUsedAt} />
                                </>
                            ) : (
                                t("alertIn.neverUsed")
                            )}
                        </p>
                    </>
                )}
                <p className="text-xs text-muted-foreground">{t("alertIn.publishHint")}</p>
                {detail.canEdit && address !== undefined && (
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => (address ? setConfirming(true) : issue())}
                    >
                        {address ? t("alertIn.reset") : t("alertIn.create")}
                    </Button>
                )}
                {error && <p className="text-xs text-danger-ink">{error}</p>}
            </div>
            {address && !secret && <AlertSnippets base={base} addressId={address.id} secret={null} />}

            <Dialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("alertIn.resetTitle")}</DialogTitle>
                        <DialogDescription>{t("alertIn.resetBody")}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirming(false)}>
                            {t("alertIn.cancel")}
                        </Button>
                        <Button disabled={pending} onClick={issue}>
                            {t("alertIn.confirm")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {secret && address && (
                <Dialog open onOpenChange={(open) => !open && setSecret(null)}>
                    <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-2xl">
                        <DialogHeader>
                            <DialogTitle>{t("alertIn.shownTitle")}</DialogTitle>
                            <DialogDescription>{t("alertIn.shownBody")}</DialogDescription>
                        </DialogHeader>
                        {/* The address and its Copy stay put; only the examples below scroll. */}
                        <div className="flex min-w-0 shrink-0 items-center gap-2">
                            <Input
                                readOnly
                                value={`${base}/api/alerts/${address.id}/${secret}`}
                                className="min-w-0 flex-1 font-mono text-xs"
                                aria-label={t("alertIn.address")}
                            />
                            <CopyButton value={`${base}/api/alerts/${address.id}/${secret}`} label={t("alertIn.copy")} />
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                            <AlertSnippets base={base} addressId={address.id} secret={secret} />
                        </div>
                        <DialogFooter>
                            <Button onClick={() => setSecret(null)}>{t("alertIn.done")}</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            )}
        </div>
    );
}

function AlertSnippets({ base, addressId, secret }: { base: string; addressId: string; secret: string | null }) {
    const t = useTranslations("automations");
    const snippets = alertSnippets(base, addressId, secret ?? "YOUR_SECRET");
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-sm font-medium">{t("alertIn.setup")}</h3>
            {!secret && <p className="text-xs text-muted-foreground">{t("alertIn.secretHidden")}</p>}
            {snippets.map((snippet) => (
                <div key={snippet.id} className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs font-medium">{t(`alertIn.snippets.${snippet.id}`)}</span>
                    <CodeView
                        value={snippet.text}
                        language={
                            snippet.id === "kuma" || snippet.id === "grafana"
                                ? "plaintext"
                                : snippet.id === "powershell"
                                  ? "powershell"
                                  : "bash"
                        }
                        label={t(`alertIn.snippets.${snippet.id}`)}
                    />
                </div>
            ))}
        </div>
    );
}

/** "Notify about the alert": what it says, how loud, and who it reaches. */
export function AlertNotifyFields({
    config,
    set,
    detail
}: {
    config: Config;
    set: (change: Config) => void;
    detail: AutomationDetail;
}) {
    const t = useTranslations("automations");
    const severities = useSeverities(2);
    const text = (key: string) => (typeof config[key] === "string" ? (config[key] as string) : "");
    const list = (key: string) =>
        Array.isArray(config[key]) ? (config[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];
    const pushFrom = typeof config.pushFrom === "number" ? config.pushFrom : 3;
    const userIds = list("recipientUserIds");
    const teamIds = list("recipientTeamIds");
    const [audience, setAudience] = useState<AlertAudience | null>(null);
    const [people, setPeople] = useState<readonly PickedPerson[]>([]);

    useEffect(() => {
        let live = true;
        void alertAudienceAction(detail.id, userIds).then((found) => {
            if (!live) return;
            setAudience(found);
            setPeople(found.people);
        });
        return () => {
            live = false;
        };
        // The names are read once; picking updates them locally.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [detail.id]);

    return (
        <div className="space-y-3">
            <Field label={t("alertNotify.title")}>
                <RefInput value={text("title")} onChange={(event) => set({ title: event.target.value })} />
            </Field>
            <Field label={t("alertNotify.body")}>
                <RefTextarea value={text("body")} onChange={(event) => set({ body: event.target.value })} />
            </Field>
            <Field label={t("alertNotify.severity")}>
                <RefInput value={text("priority")} onChange={(event) => set({ priority: event.target.value })} />
            </Field>
            <Field label={t("alertNotify.pushFrom")}>
                <Select
                    value={String(pushFrom)}
                    onValueChange={(value) => set({ pushFrom: Number(value) })}
                    options={severities}
                    aria-label={t("alertNotify.pushFrom")}
                />
            </Field>
            <p className="text-xs text-muted-foreground">{t("alertNotify.pushHint")}</p>
            {audience === null ? (
                <Skeleton className="h-9 w-full" />
            ) : audience.orgId === null ? (
                <p className="text-xs text-muted-foreground">{t("alertNotify.personal")}</p>
            ) : (
                <>
                    <PeoplePicker
                        picked={people}
                        label={t("alertNotify.people")}
                        max={core.ALERT_LIMITS.recipients}
                        search={(query) => alertPeopleAction(detail.id, query)}
                        onChange={(picked) => {
                            setPeople(picked);
                            set({ recipientUserIds: picked.map((person) => person.id) });
                        }}
                    />
                    <div className="flex flex-col gap-1 text-sm">
                        {t("alertNotify.teams")}
                        {audience.teams.length === 0 ? (
                            <span className="text-xs text-muted-foreground">{t("alertNotify.noTeams")}</span>
                        ) : (
                            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto overscroll-contain">
                                {audience.teams.map((team) => (
                                    <label key={team.id} className="flex min-w-0 items-center gap-2">
                                        <Checkbox
                                            checked={teamIds.includes(team.id)}
                                            onChange={(event) =>
                                                set({
                                                    recipientTeamIds: event.target.checked
                                                        ? [...teamIds, team.id]
                                                        : teamIds.filter((one) => one !== team.id)
                                                })
                                            }
                                        />
                                        <span className="truncate" title={team.name}>
                                            {team.name}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
