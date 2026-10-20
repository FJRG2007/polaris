"use client";

/**
 * A UPS's own settings: its energy price and rating, how long its readings
 * are kept, which events notify, its scheduled report, and whether other
 * machines may follow it over the network - plus exporting what it recorded.
 * One form, saved together, validated with the schema the action parses with.
 */

import { useState } from "react";
import * as upsEvents from "@/lib/ups/ups-events";
import type { UpsView } from "@/lib/ups/ups-service";
import * as upsSettings from "@/lib/ups/ups-settings";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Download, FileText, HardDrive, KeyRound } from "lucide-react";
import { Button, Checkbox, CopyButton, Input, Select, Switch, useToast } from "@polaris/ui";
import {
    makeUpsReportAction,
    saveUpsExportAction,
    updateUpsSettingsAction,
    upsNetworkLoginAction
} from "../actions";

const EXPORT_DAYS = ["7", "30", "90", "365"] as const;

export function UpsSettingsPanel({
    ups,
    canOfferNetwork
}: {
    ups: UpsView;
    canOfferNetwork: boolean;
}) {
    const t = useTranslations("servers");
    const toast = useToast();
    const [saved, setSaved] = useState(ups.settings);
    const [draft, setDraft] = useState(ups.settings);
    const [price, setPrice] = useState(saved.pricePerKwh === null ? "" : String(saved.pricePerKwh));
    const [rating, setRating] = useState(
        saved.nominalPowerW === null ? "" : String(saved.nominalPowerW)
    );
    const [retention, setRetention] = useState(String(saved.retentionDays));
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [login, setLogin] = useState<{
        user: string;
        password: string;
        port: number;
        upsName: string;
    } | null>(null);
    const [what, setWhat] = useState<upsSettings.ExportKind>("samples");
    const [days, setDays] = useState<(typeof EXPORT_DAYS)[number]>("30");

    const number = (raw: string) => (raw.trim() === "" ? null : Number(raw.replace(",", ".")));
    const candidate = {
        ...draft,
        pricePerKwh: number(price),
        nominalPowerW: number(rating),
        retentionDays: retention.trim() === "" ? Number.NaN : Number(retention)
    };
    const parsed = upsSettings.upsSettingsSchema.safeParse(
        upsSettings.normalizeUpsSettings(candidate)
    );
    const issue = parsed.success ? null : parsed.error.issues[0]?.message;
    const incomplete = draft.currency.trim() === "" || retention.trim() === "";
    const dirty = parsed.success ? JSON.stringify(parsed.data) !== JSON.stringify(saved) : true;

    async function save() {
        if (!parsed.success) return;
        setPending(true);
        setError(null);
        const outcome = await updateUpsSettingsAction(ups.id, parsed.data);
        setPending(false);
        if (!outcome.ok) {
            setError(
                outcome.error === "networkUnavailable"
                    ? t("ups.settings.errors.networkUnavailable")
                    : t("ups.errors.failed")
            );
            return;
        }
        setSaved(parsed.data);
        setLogin(null);
        toast.show({ key: `ups:${ups.id}:settings`, title: t("ups.settings.saved") });
    }

    async function reveal() {
        const outcome = await upsNetworkLoginAction(ups.id);
        if (outcome.ok) setLogin(outcome.value);
        else
            toast.show({
                key: `ups:${ups.id}:login`,
                title: t("ups.settings.errors.networkUnavailable")
            });
    }

    async function toDrive(
        run: () => Promise<{ ok: true; value: string } | { ok: false; error: string }>
    ) {
        const outcome = await run();
        toast.show({
            key: `ups:${ups.id}:drive`,
            title: outcome.ok
                ? t("ups.settings.savedTo", { path: outcome.value })
                : t("ups.errors.failed")
        });
    }

    const KNOWN = ["invalidPrice", "invalidPower", "invalidRetention", "invalidCurrency"] as const;
    const field = (key: string) =>
        issue && !incomplete
            ? t(
                  `ups.settings.errors.${(KNOWN as readonly string[]).includes(key) ? (key as (typeof KNOWN)[number]) : "invalid"}`
              )
            : null;
    const toggleKind = (kind: upsEvents.UpsEventKind, on: boolean) =>
        setDraft((current) => ({
            ...current,
            notifyKinds: on
                ? [...current.notifyKinds, kind]
                : current.notifyKinds.filter((one) => one !== kind)
        }));

    return (
        <div className="flex max-w-3xl flex-col gap-8">
            <section aria-labelledby="ups-settings-energy" className="flex flex-col gap-3">
                <h3 id="ups-settings-energy" className="text-sm font-medium">
                    {t("ups.settings.energy")}
                </h3>
                <div className="grid gap-3 sm:grid-cols-3">
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                        {t("ups.settings.currency")} *
                        <Input
                            value={draft.currency}
                            maxLength={3}
                            placeholder="EUR"
                            onChange={(event) =>
                                setDraft({ ...draft, currency: event.target.value })
                            }
                        />
                    </label>
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                        {t("ups.settings.price")}
                        <Input
                            inputMode="decimal"
                            value={price}
                            placeholder="0.15"
                            onChange={(event) => setPrice(event.target.value)}
                        />
                    </label>
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                        {t("ups.settings.rating")}
                        <Input
                            inputMode="numeric"
                            value={rating}
                            placeholder="600"
                            onChange={(event) => setRating(event.target.value)}
                        />
                    </label>
                </div>
                <p className="text-xs text-muted-foreground">{t("ups.settings.ratingHint")}</p>
            </section>

            <section aria-labelledby="ups-settings-notify" className="flex flex-col gap-3">
                <h3 id="ups-settings-notify" className="text-sm font-medium">
                    {t("ups.settings.notify")}
                </h3>
                <p className="text-sm text-muted-foreground">{t("ups.settings.notifyIntro")}</p>
                <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {upsEvents.UPS_EVENT_KINDS.map((kind) => (
                        <label key={kind} className="flex min-w-0 items-center gap-2 text-sm">
                            <Checkbox
                                checked={draft.notifyKinds.includes(kind)}
                                onChange={(event) => toggleKind(kind, event.target.checked)}
                            />
                            <span className="truncate">{t(`ups.kinds.${kind}`)}</span>
                        </label>
                    ))}
                </div>
            </section>

            <section aria-labelledby="ups-settings-reports" className="flex flex-col gap-3">
                <h3 id="ups-settings-reports" className="text-sm font-medium">
                    {t("ups.settings.reports")}
                </h3>
                <p className="text-sm text-muted-foreground">{t("ups.settings.reportsIntro")}</p>
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        aria-label={t("ups.settings.reports")}
                        className="w-48"
                        value={draft.reportSchedule}
                        onValueChange={(value) =>
                            setDraft({
                                ...draft,
                                reportSchedule: value as upsSettings.ReportSchedule
                            })
                        }
                        options={upsSettings.REPORT_SCHEDULES.map((one) => ({
                            value: one,
                            label: t(`ups.settings.schedules.${one}`)
                        }))}
                    />
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void toDrive(() => makeUpsReportAction(ups.id))}
                    >
                        <FileText className="size-4 shrink-0" aria-hidden />
                        {t("ups.settings.reportNow")}
                    </Button>
                </div>
                {ups.reportLastAt ? (
                    <p className="text-xs text-muted-foreground">
                        {t("ups.settings.reportLast", {
                            when: new Date(ups.reportLastAt).toLocaleString()
                        })}
                    </p>
                ) : null}
            </section>

            <section aria-labelledby="ups-settings-data" className="flex flex-col gap-3">
                <h3 id="ups-settings-data" className="text-sm font-medium">
                    {t("ups.settings.data")}
                </h3>
                <label className="flex max-w-xs flex-col gap-1 text-sm">
                    {t("ups.settings.retention")} *
                    <Input
                        inputMode="numeric"
                        value={retention}
                        onChange={(event) => setRetention(event.target.value)}
                    />
                </label>
                <p className="text-xs text-muted-foreground">{t("ups.settings.retentionHint")}</p>
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        aria-label={t("ups.settings.exportWhat")}
                        className="w-44"
                        value={what}
                        onValueChange={(value) => setWhat(value as upsSettings.ExportKind)}
                        options={upsSettings.EXPORT_KINDS.map((one) => ({
                            value: one,
                            label: t(`ups.settings.exports.${one}`)
                        }))}
                    />
                    <Select
                        aria-label={t("ups.settings.exportDays")}
                        className="w-36"
                        value={days}
                        onValueChange={(value) => setDays(value as typeof days)}
                        options={EXPORT_DAYS.map((one) => ({
                            value: one,
                            label: t("ups.events.days", { count: Number(one) })
                        }))}
                    />
                    <Button asChild size="sm" variant="outline">
                        <a
                            href={`/api/servers/ups/${ups.id}/export?what=${what}&days=${days}`}
                            download
                        >
                            <Download className="size-4 shrink-0" aria-hidden />
                            {t("ups.settings.download")}
                        </a>
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                            void toDrive(() =>
                                saveUpsExportAction(ups.id, { what, days: Number(days) })
                            )
                        }
                    >
                        <HardDrive className="size-4 shrink-0" aria-hidden />
                        {t("ups.settings.toDrive")}
                    </Button>
                </div>
            </section>

            <section aria-labelledby="ups-settings-network" className="flex flex-col gap-3">
                <h3 id="ups-settings-network" className="text-sm font-medium">
                    {t("ups.settings.network")}
                </h3>
                <p className="text-sm text-muted-foreground">
                    {canOfferNetwork
                        ? t("ups.settings.networkIntro")
                        : t("ups.settings.networkUnavailable")}
                </p>
                {canOfferNetwork ? (
                    <label className="flex items-center gap-2 text-sm">
                        <Switch
                            checked={draft.netserverEnabled}
                            aria-label={t("ups.settings.networkOn")}
                            onChange={(on) => setDraft({ ...draft, netserverEnabled: on })}
                        />
                        {t("ups.settings.networkOn")}
                    </label>
                ) : null}
                {canOfferNetwork && saved.netserverEnabled ? (
                    login ? (
                        <div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3 text-sm">
                            <p>{t("ups.settings.networkHow")}</p>
                            <div className="flex min-w-0 items-center gap-2">
                                <code className="min-w-0 flex-1 truncate text-xs">
                                    {`MONITOR ${login.upsName}@<${t("ups.settings.thisMachine")}>:${login.port} 1 ${login.user} ${login.password} secondary`}
                                </code>
                                <CopyButton
                                    value={`MONITOR ${login.upsName}@<${t("ups.settings.thisMachine")}>:${login.port} 1 ${login.user} ${login.password} secondary`}
                                    label={t("ups.settings.copyLine")}
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {t("ups.settings.networkPort", { port: login.port })}
                            </p>
                        </div>
                    ) : (
                        <Button
                            size="sm"
                            variant="outline"
                            className="self-start"
                            onClick={() => void reveal()}
                        >
                            <KeyRound className="size-4 shrink-0" aria-hidden />
                            {t("ups.settings.showLogin")}
                        </Button>
                    )
                ) : null}
            </section>

            {error || field(issue ?? "") ? (
                <p role="alert" className="text-sm text-danger-ink">
                    {error ?? field(issue ?? "")}
                </p>
            ) : null}
            <div>
                <Button
                    aria-disabled={!dirty || !parsed.success || pending}
                    disabled={pending}
                    onClick={() => {
                        if (dirty && parsed.success) void save();
                    }}
                >
                    {t("ups.settings.save")}
                </Button>
            </div>
        </div>
    );
}
