"use client";

/**
 * The Ad blocker's Settings: who answers what it lets through, safe search,
 * and how long it keeps what it saw and how often it reads its lists again.
 */

import { Button, Card, CardBody, CardHeader, CardTitle, Input, Select, Switch } from "@polaris/ui";
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
    const [engine, setEngine] = useField("engine");
    const [cacheMinText, setCacheMinText] = useField("cacheMinText");
    const [cacheMaxText, setCacheMaxText] = useField("cacheMaxText");

    const { badUpstreams, customEmpty, daysValid, namesFromValid, hoursValid, engineIssue } =
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
            <Card>
                <CardHeader>
                    <CardTitle>{t("engine.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("engine.intro")}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-start gap-4">
                        <label className="flex flex-col gap-1 text-sm">
                            <span>{t("engine.cacheMin")}</span>
                            <Input
                                className="w-28"
                                type="number"
                                min={0}
                                max={1440}
                                value={cacheMinText}
                                aria-invalid={engineIssue === "cacheMinutes"}
                                onChange={(event) => setCacheMinText(event.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            <span>{t("engine.cacheMax")}</span>
                            <Input
                                className="w-28"
                                type="number"
                                min={0}
                                max={1440}
                                value={cacheMaxText}
                                aria-invalid={engineIssue !== null}
                                onChange={(event) => setCacheMaxText(event.target.value)}
                            />
                        </label>
                        <label className="flex items-center gap-2 self-center text-sm">
                            <Switch
                                checked={engine.prefetch}
                                onChange={(prefetch: boolean) =>
                                    setEngine((current) => ({ ...current, prefetch }))
                                }
                            />
                            <span>{t("engine.prefetch")}</span>
                        </label>
                    </div>
                    <p
                        className={`text-xs ${engineIssue ? "text-danger-ink" : "text-muted-foreground"}`}
                    >
                        {engineIssue ? t(`validation.${engineIssue}`) : t("engine.cacheHint")}
                    </p>
                    <div className="flex flex-col gap-1 text-sm">
                        <span>{t("engine.dropTypes")}</span>
                        <div className="flex flex-wrap gap-1">
                            {dns.DNS_DROP_TYPES.map((type) => {
                                const on = engine.dropTypes.includes(type);
                                return (
                                    <Button
                                        key={type}
                                        size="sm"
                                        variant={on ? "primary" : "outline"}
                                        aria-pressed={on}
                                        onClick={() =>
                                            setEngine((current) => ({
                                                ...current,
                                                dropTypes: on
                                                    ? current.dropTypes.filter(
                                                          (item) => item !== type
                                                      )
                                                    : [...current.dropTypes, type]
                                            }))
                                        }
                                    >
                                        {type}
                                    </Button>
                                );
                            })}
                        </div>
                        <span className="text-xs text-muted-foreground">
                            {t("engine.dropTypesHint")}
                        </span>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">
                        <span aria-hidden>{t("engine.blockReply")}</span>
                        <Select
                            className="w-full sm:w-56"
                            value={engine.blockReply}
                            aria-label={t("engine.blockReply")}
                            onValueChange={(value) =>
                                setEngine((current) => ({
                                    ...current,
                                    blockReply: value as dns.DnsEngine["blockReply"]
                                }))
                            }
                            options={[
                                { value: "zeroIp", label: t("engine.zeroIp") },
                                { value: "nxDomain", label: t("engine.nxDomain") }
                            ]}
                        />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                        <Switch
                            checked={engine.fqdnOnly}
                            onChange={(fqdnOnly: boolean) =>
                                setEngine((current) => ({ ...current, fqdnOnly }))
                            }
                        />
                        <span>{t("engine.fqdnOnly")}</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                        <Switch
                            checked={engine.dnssec}
                            onChange={(dnssec: boolean) =>
                                setEngine((current) => ({ ...current, dnssec }))
                            }
                        />
                        <span>{t("engine.dnssec")}</span>
                    </label>
                </CardBody>
            </Card>
            <DnsSaveBar />
        </div>
    );
}
