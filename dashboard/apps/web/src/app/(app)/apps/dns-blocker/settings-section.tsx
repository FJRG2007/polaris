"use client";

/**
 * The Ad blocker's Settings: who answers what it lets through, safe search,
 * and how long it keeps what it saw and how often it reads its lists again.
 */

import { Card, CardBody, CardHeader, CardTitle, Input, Select, Switch } from "@polaris/ui";
import * as dns from "@/lib/dns-blocker/settings";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";
import { RuleField } from "./fields";
import { useDnsBlocker, useField } from "./dns-blocker-context";
import { DnsSaveBar } from "./save-bar";

export function DnsSettingsSection() {
    const t = useTranslations("dnsBlocker");
    const [upstream, setUpstream] = useField("upstream");
    const [upstreamText, setUpstreamText] = useField("upstreamText");
    const [safeSearch, setSafeSearch] = useField("safeSearch");
    const [youtube, setYoutube] = useField("youtube");
    const [logDays, setLogDays] = useField("logDays");
    const [namesFrom, setNamesFrom] = useField("namesFrom");
    const [refreshHours, setRefreshHours] = useField("refreshHours");

    const { badUpstreams, customEmpty, daysValid, namesFromValid, hoursValid } =
        useDnsBlocker().checks;

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardHeader>
                    <CardTitle>{t("upstream.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("upstream.intro")}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    <Select
                        className="w-full sm:w-72"
                        value={upstream}
                        aria-label={t("upstream.title")}
                        onValueChange={setUpstream}
                        options={[
                            ...dns.DNS_UPSTREAM_PRESETS.map((preset) => ({
                                value: preset.id,
                                label: t(`upstreams.${preset.id}` as NamespaceKey<"dnsBlocker">)
                            })),
                            { value: "custom", label: t("upstreams.custom") }
                        ]}
                    />
                    {upstream === "custom" ? (
                        <RuleField
                            label={t("upstream.custom")}
                            value={upstreamText}
                            onChange={setUpstreamText}
                            bad={badUpstreams}
                            badText={t("validation.invalidUpstream")}
                            placeholder={
                                "https://dns.example/dns-query\ntcp-tls:dns.example:853\n9.9.9.9"
                            }
                            missing={customEmpty ? t("validation.upstreamMissing") : null}
                        />
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("safe.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("safe.intro")}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6">
                    <label className="flex items-center gap-2 text-sm">
                        <Switch checked={safeSearch} onChange={setSafeSearch} />
                        <span>{t("safe.search")}</span>
                    </label>
                    <div className="flex min-w-0 flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">
                        <span aria-hidden>{t("safe.youtube")}</span>
                        <Select
                            className="w-full sm:w-48"
                            value={youtube}
                            aria-label={t("safe.youtube")}
                            onValueChange={(value) => setYoutube(value as typeof youtube)}
                            options={[
                                { value: "off", label: t("safe.youtubeOff") },
                                { value: "moderate", label: t("safe.youtubeModerate") },
                                { value: "strict", label: t("safe.youtubeStrict") }
                            ]}
                        />
                    </div>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("history.title")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-wrap gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("history.days")}</span>
                        <Input
                            className="w-28"
                            type="number"
                            min={1}
                            max={dns.DNS_LIMITS.logDays}
                            value={logDays}
                            aria-invalid={!daysValid}
                            onChange={(event) => setLogDays(event.target.value)}
                        />
                        {!daysValid ? (
                            <span className="text-xs text-danger-ink">
                                {t("validation.logDays", { max: dns.DNS_LIMITS.logDays })}
                            </span>
                        ) : null}
                    </label>
                    <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                        <span>{t("history.namesFrom")}</span>
                        <Input
                            className="w-full sm:w-48"
                            value={namesFrom}
                            placeholder="192.168.1.1"
                            aria-invalid={!namesFromValid}
                            onChange={(event) => setNamesFrom(event.target.value)}
                        />
                        <span
                            className={`text-xs ${namesFromValid ? "text-muted-foreground" : "text-danger-ink"}`}
                        >
                            {namesFromValid
                                ? t("history.namesFromHint")
                                : t("validation.invalidAddress")}
                        </span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("settings.refresh")}</span>
                        <Input
                            className="w-28"
                            type="number"
                            min={1}
                            max={168}
                            value={refreshHours}
                            aria-invalid={!hoursValid}
                            onChange={(event) => setRefreshHours(event.target.value)}
                        />
                        {!hoursValid ? (
                            <span className="text-xs text-danger">{t("validation.refresh")}</span>
                        ) : null}
                    </label>
                </CardBody>
            </Card>
            <DnsSaveBar />
        </div>
    );
}
