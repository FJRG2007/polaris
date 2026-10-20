"use client";

/**
 * The Ad blocker screen: where it stands, what the router needs, and what it
 * blocks.
 *
 * The settings arrive with the page (one row); where the blocker stands is asked
 * of port 53 after the first paint, so only the status card waits. Every field is
 * checked as it is typed against the schema the save path uses, and Save stays
 * off until the values differ from what was loaded.
 */

import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    CopyButton,
    Input,
    SearchableSelect,
    Select,
    Skeleton,
    Switch,
    Textarea
} from "@polaris/ui";
import * as dns from "@/lib/dns-blocker/settings";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";
import type { DnsBlockerState, DnsBlockerStatus } from "@/lib/dns-blocker/service";
import {
    dnsBlockerStatusAction,
    saveDnsSettingsAction,
    turnOffDnsBlockerAction,
    turnOnDnsBlockerAction
} from "./actions";
import { DnsInsightsCard } from "./dns-insights";
import { RouterDnsGuide, type RouterBrandOption } from "./router-dns-guide";

/** One rule or resolver per line, blank lines ignored. */
function lines(text: string): string[] {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

/** The lines `normalize` refuses, for saying which ones are wrong. */
function rejected(text: string, normalize: (line: string) => string | null): string[] {
    return lines(text).filter((line) => normalize(line) === null);
}

const STATE_TONE: Record<DnsBlockerState, "success" | "warning" | "danger" | "neutral"> = {
    blocking: "success",
    starting: "neutral",
    off: "neutral",
    portTaken: "warning",
    portHeld: "danger",
    conflict: "danger",
    noAddress: "warning"
};

/** How many times a starting server is looked at on its own, 4 s apart. */
const STARTING_CHECKS = 15;

/** States in which a DNS server of ours exists. */
const ENGINE_STATES: readonly DnsBlockerState[] = ["blocking", "starting", "portHeld", "conflict"];

/** Every zone this browser knows, with `current` kept even when it does not
 *  list it (an older runtime without `supportedValuesOf`). */
function timeZones(current: string): string[] {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    let zones: string[] = [];
    try {
        zones = supported ? supported("timeZone") : [];
    } catch {
        zones = [];
    }
    return zones.includes(current) ? zones : [current, ...zones];
}

/** The zone this browser is in, which a first schedule is written in. */
function browserTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
}

/** Addresses, a range and a name pattern, as typed into a group. */
const GROUP_CLIENTS_EXAMPLE = "192.168.1.20\n192.168.1.64/26\nkids-*"; // i18n-ignore example values

export function DnsBlockerView({
    initial,
    brands
}: {
    initial: dns.DnsSettings;
    brands: RouterBrandOption[];
}) {
    const t = useTranslations("dnsBlocker");
    const [status, setStatus] = useState<DnsBlockerStatus | null>(null);
    const [statusError, setStatusError] = useState<string | null>(null);
    const [checking, startChecking] = useTransition();
    const [switching, startSwitching] = useTransition();
    const [saving, startSaving] = useTransition();
    const [saved, setSaved] = useState(initial);
    const [notice, setNotice] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

    // The form. Rules and resolvers are edited as text, one per line.
    const [sources, setSources] = useState<string[]>(initial.sources);
    const [customLists, setCustomLists] = useState(initial.customLists);
    const [allowText, setAllowText] = useState(initial.allow.join("\n"));
    const [denyText, setDenyText] = useState(initial.deny.join("\n"));
    const [upstream, setUpstream] = useState(initial.upstream);
    const [upstreamText, setUpstreamText] = useState(initial.customUpstreams.join("\n"));
    const [records, setRecords] = useState(initial.records);
    const [refreshHours, setRefreshHours] = useState(String(initial.refreshHours));
    const [listUrl, setListUrl] = useState("");
    const [listCategory, setListCategory] = useState<dns.DnsCategory>("ads");
    const [recordName, setRecordName] = useState("");
    const [recordAddress, setRecordAddress] = useState("");
    const [aliases, setAliases] = useState(initial.aliases);
    const [aliasName, setAliasName] = useState("");
    const [aliasTarget, setAliasTarget] = useState("");
    const [clientGroups, setClientGroups] = useState(initial.clientGroups);
    const [groupName, setGroupName] = useState("");
    const [groupClients, setGroupClients] = useState("");
    const [groupCategories, setGroupCategories] = useState<dns.DnsCategory[]>([]);
    const [logDays, setLogDays] = useState(String(initial.logDays));
    const [namesFrom, setNamesFrom] = useState(initial.namesFrom);
    const [devices, setDevices] = useState(initial.devices);
    const [forwards, setForwards] = useState(initial.forwards);
    const [safeSearch, setSafeSearch] = useState(initial.safeSearch);
    const [youtube, setYoutube] = useState(initial.youtube);
    const [forwardDomain, setForwardDomain] = useState("");
    const [forwardServer, setForwardServer] = useState("");
    const [deviceName, setDeviceName] = useState("");
    const [deviceAddress, setDeviceAddress] = useState("");
    const [schedules, setSchedules] = useState(initial.schedules);
    // Read after the first paint: the server does not know the reader's zone.
    const [timeZone, setTimeZone] = useState(initial.timeZone || "UTC");
    useEffect(() => {
        if (!initial.timeZone) setTimeZone(browserTimeZone());
    }, [initial.timeZone]);
    const [scheduleLists, setScheduleLists] = useState<string[]>([]);
    const [scheduleDays, setScheduleDays] = useState<dns.DnsWeekday[]>([]);
    const [scheduleWhole, setScheduleWhole] = useState(false);
    const [scheduleStart, setScheduleStart] = useState("21:00");
    const [scheduleEnd, setScheduleEnd] = useState("07:00");

    /** A rule set from the query log: the lists as saved, without touching
     *  a list somebody is editing here. */
    const adoptRules = useCallback(
        (next: dns.DnsSettings) => {
            setAllowText((current) =>
                current === saved.allow.join("\n") ? next.allow.join("\n") : current
            );
            setDenyText((current) =>
                current === saved.deny.join("\n") ? next.deny.join("\n") : current
            );
            setSaved((current) => ({ ...current, allow: next.allow, deny: next.deny }));
        },
        [saved]
    );

    const [startingChecks, setStartingChecks] = useState(0);

    const check = useCallback(() => {
        startChecking(async () => {
            const result = await dnsBlockerStatusAction();
            if (result.error !== undefined) {
                setStatusError(result.error);
                return;
            }
            setStatusError(null);
            setStatus(result.status);
        });
    }, []);

    useEffect(() => check(), [check]);

    /** A check somebody asked for, which also starts the automatic ones over. */
    const recheck = useCallback(() => {
        setStartingChecks(0);
        check();
    }, [check]);

    // While the server is coming up, look again on its own a few times, then
    // stop and say it has not come up rather than asking for ever.
    const stalled = status?.state === "starting" && startingChecks >= STARTING_CHECKS;
    useEffect(() => {
        if (status?.state !== "starting" || startingChecks >= STARTING_CHECKS) return;
        const timer = setTimeout(() => {
            setStartingChecks((count) => count + 1);
            check();
        }, 4000);
        return () => clearTimeout(timer);
    }, [status, startingChecks, check]);

    const badAllow = rejected(allowText, dns.normalizeDnsRule);
    const badDeny = rejected(denyText, dns.normalizeDnsRule);
    const badUpstreams = upstream === "custom" ? rejected(upstreamText, dns.normalizeUpstream) : [];
    const hours = Number(refreshHours);
    const hoursValid = Number.isInteger(hours) && hours >= 1 && hours <= 168;
    const customEmpty = upstream === "custom" && lines(upstreamText).length === 0;
    const days = Number(logDays);
    const daysValid = Number.isInteger(days) && days >= 1 && days <= dns.DNS_LIMITS.logDays;
    const namesFromValid = dns.dnsSettingsSchema.shape.namesFrom.safeParse(namesFrom).success;
    const recordNames = new Set(records.map((record) => record.name));
    const aliasClash = aliases
        .filter((alias) => recordNames.has(alias.name))
        .map((alias) => alias.name);

    const draft: dns.DnsSettings = useMemo(
        () => ({
            sources,
            customLists,
            allow: lines(allowText).map((line) => dns.normalizeDnsRule(line) ?? line),
            deny: lines(denyText).map((line) => dns.normalizeDnsRule(line) ?? line),
            upstream,
            customUpstreams: upstream === "custom" ? lines(upstreamText) : [],
            records,
            refreshHours: hours,
            aliases,
            clientGroups,
            logDays: days,
            devices,
            forwards,
            safeSearch,
            youtube,
            schedules,
            // The zone is only worth storing with something written in it.
            timeZone: schedules.length > 0 ? timeZone : saved.timeZone,
            namesFrom: namesFrom.trim()
        }),
        [
            sources,
            customLists,
            allowText,
            denyText,
            upstream,
            upstreamText,
            records,
            hours,
            aliases,
            clientGroups,
            days,
            devices,
            forwards,
            safeSearch,
            youtube,
            schedules,
            timeZone,
            saved.timeZone,
            namesFrom
        ]
    );
    const dirty =
        JSON.stringify(draft) !==
        JSON.stringify({
            ...saved,
            customUpstreams: saved.upstream === "custom" ? saved.customUpstreams : []
        });
    const tooMany =
        draft.allow.length > dns.DNS_LIMITS.rules || draft.deny.length > dns.DNS_LIMITS.rules;
    const valid =
        badAllow.length === 0 &&
        badDeny.length === 0 &&
        badUpstreams.length === 0 &&
        hoursValid &&
        daysValid &&
        namesFromValid &&
        aliasClash.length === 0 &&
        !customEmpty &&
        !tooMany;

    const newList = dns.dnsCustomListSchema.safeParse({ url: listUrl, category: listCategory });
    const newRecord = dns.dnsRecordSchema.safeParse({ name: recordName, address: recordAddress });
    const newAlias = dns.dnsAliasSchema.safeParse({ name: aliasName, target: aliasTarget });
    const newForward = dns.dnsForwardSchema.safeParse({
        domain: forwardDomain,
        server: forwardServer
    });
    const forwardIssue = newForward.success
        ? null
        : (newForward.error.issues.find((issue) =>
              issue.path[0] === "domain" ? forwardDomain.trim() !== "" : forwardServer.trim() !== ""
          )?.message ?? null);
    const newDevice = dns.dnsDeviceSchema.safeParse({ name: deviceName, address: deviceAddress });
    const deviceIssue = newDevice.success
        ? null
        : (newDevice.error.issues.find((issue) =>
              issue.path[0] === "name" ? deviceName.trim() !== "" : deviceAddress.trim() !== ""
          )?.message ?? null);
    const listed = dns.dnsListedCategories({ sources, customLists });
    const newSchedule = dns.dnsScheduleSchema.safeParse({
        lists: scheduleLists.filter((list) => (listed as string[]).includes(list)),
        days: scheduleDays,
        start: scheduleWhole ? "" : scheduleStart,
        end: scheduleWhole ? "" : scheduleEnd
    });
    // Only the hours are said wrong; no list or no day yet is not finished.
    const scheduleIssue = newSchedule.success
        ? null
        : (newSchedule.error.issues.find(
              (issue) => issue.path[0] === "start" || issue.path[0] === "end"
          )?.message ?? null);
    const badGroupClients = rejected(groupClients, dns.normalizeDnsClient);
    const newGroup = dns.dnsClientGroupSchema.safeParse({
        name: groupName,
        clients: lines(groupClients),
        categories: groupCategories
    });

    function save(): void {
        setNotice(null);
        startSaving(async () => {
            const result = await saveDnsSettingsAction(draft);
            const engineOn = status ? ENGINE_STATES.includes(status.state) : false;
            if (result.error) {
                setNotice({ tone: "error", text: result.error });
                if (engineOn) recheck();
                return;
            }
            setSaved(draft);
            setNotice({ tone: "ok", text: t("settings.saved") });
            if (engineOn) recheck();
        });
    }

    function switchTo(on: boolean): void {
        setNotice(null);
        startSwitching(async () => {
            const result = on ? await turnOnDnsBlockerAction() : await turnOffDnsBlockerAction();
            if (result.error) setNotice({ tone: "error", text: result.error });
            recheck();
        });
    }

    const state = status?.state;
    const engineExists = state ? ENGINE_STATES.includes(state) : false;

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardHeader className="flex-row items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <CardTitle className="truncate">{t("status.title")}</CardTitle>
                        {state ? (
                            <Badge variant={stalled ? "danger" : STATE_TONE[state]}>
                                {stalled ? t("states.stalled.label") : t(`states.${state}.label`)}
                            </Badge>
                        ) : null}
                    </div>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={recheck}
                        disabled={checking}
                        aria-label={t("status.check")}
                        title={t("status.check")}
                    >
                        <RefreshCw className={checking ? "animate-spin" : undefined} />
                    </Button>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    {status ? (
                        <>
                            <p className="text-sm text-muted-foreground">
                                {t(
                                    stalled ? "states.stalled.body" : `states.${status.state}.body`,
                                    {
                                        address: status.address ?? ""
                                    }
                                )}
                            </p>
                            <div className="flex flex-wrap gap-2">
                                {!engineExists ? (
                                    <Button
                                        size="sm"
                                        onClick={() => switchTo(true)}
                                        disabled={switching || state === "noAddress"}
                                    >
                                        {switching ? <Loader2 className="animate-spin" /> : null}
                                        {state === "portTaken"
                                            ? t("actions.retry")
                                            : t("actions.turnOn")}
                                    </Button>
                                ) : null}
                                {state === "portHeld" || state === "conflict" || stalled ? (
                                    <Button
                                        size="sm"
                                        onClick={() => switchTo(true)}
                                        disabled={switching}
                                    >
                                        {switching ? <Loader2 className="animate-spin" /> : null}
                                        {t("actions.retry")}
                                    </Button>
                                ) : null}
                                {engineExists ? (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => switchTo(false)}
                                        disabled={switching}
                                    >
                                        {t("actions.turnOff")}
                                    </Button>
                                ) : null}
                            </div>
                        </>
                    ) : statusError ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <p role="alert" className="text-sm text-danger">
                                {statusError}
                            </p>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={recheck}
                                disabled={checking}
                            >
                                {t("actions.retry")}
                            </Button>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2" aria-busy="true">
                            <Skeleton className="h-4 w-3/4" />
                            <Skeleton className="h-8 w-28" />
                        </div>
                    )}
                    {status?.stale && state === "blocking" ? (
                        <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft p-2">
                            <p className="min-w-0 flex-1 text-sm text-warning-ink">
                                {t("status.stale")}
                            </p>
                            <Button size="sm" onClick={() => switchTo(true)} disabled={switching}>
                                {switching ? <Loader2 className="animate-spin" /> : null}
                                {t("status.apply")}
                            </Button>
                        </div>
                    ) : null}
                    {notice ? (
                        <p
                            role={notice.tone === "error" ? "alert" : "status"}
                            className={
                                notice.tone === "error"
                                    ? "text-sm text-danger"
                                    : "text-sm text-success"
                            }
                        >
                            {notice.text}
                        </p>
                    ) : null}
                </CardBody>
            </Card>
            {state === "blocking" ? (
                <DnsInsightsCard
                    onApplied={recheck}
                    onRules={adoptRules}
                    logDays={saved.logDays}
                    refreshHours={saved.refreshHours}
                />
            ) : null}

            <Card>
                <CardHeader>
                    <CardTitle>{t("router.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("router.intro")}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="text-sm text-muted-foreground">
                            {t("router.dnsServer")}
                        </span>
                        {status?.address ? (
                            <>
                                <code
                                    className="truncate rounded bg-muted px-1.5 py-0.5 text-sm"
                                    title={status.address}
                                >
                                    {status.address}
                                </code>
                                <CopyButton value={status.address} />
                            </>
                        ) : status ? (
                            <span className="text-sm">{t("router.noAddress")}</span>
                        ) : (
                            <Skeleton className="h-5 w-28" />
                        )}
                    </div>
                    <RouterDnsGuide
                        address={status?.address ?? null}
                        blocking={state === "blocking"}
                        brands={brands}
                    />
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("lists.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("lists.intro")}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                    {dns.DNS_CATEGORIES.map((category) => {
                        const offered = dns.DNS_LIST_SOURCES.filter(
                            (source) => source.category === category
                        );
                        if (offered.length === 0) return null;
                        return (
                            <div key={category} className="flex flex-col gap-2">
                                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    {t(`categories.${category}`)}
                                </h4>
                                {offered.map((source) => (
                                    <label
                                        key={source.id}
                                        className="flex min-w-0 items-center justify-between gap-3 text-sm"
                                    >
                                        <span className="truncate" title={source.url}>
                                            {t(
                                                `sources.${source.id}` as NamespaceKey<"dnsBlocker">
                                            )}
                                        </span>
                                        <Switch
                                            checked={sources.includes(source.id)}
                                            aria-label={t(
                                                `sources.${source.id}` as NamespaceKey<"dnsBlocker">
                                            )}
                                            onChange={(on) =>
                                                setSources((current) =>
                                                    on
                                                        ? [...current, source.id]
                                                        : current.filter((id) => id !== source.id)
                                                )
                                            }
                                        />
                                    </label>
                                ))}
                            </div>
                        );
                    })}
                    <div className="flex flex-col gap-2">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {t("lists.custom")}
                        </h4>
                        {customLists.map((list, index) => (
                            <div
                                key={`${list.url}-${index}`}
                                className="flex min-w-0 items-center gap-2 text-sm"
                            >
                                <span className="min-w-0 flex-1 truncate" title={list.url}>
                                    {list.url}
                                </span>
                                <Badge variant="neutral">{t(`categories.${list.category}`)}</Badge>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label={t("lists.remove")}
                                    title={t("lists.remove")}
                                    onClick={() =>
                                        setCustomLists((current) =>
                                            current.filter((_, at) => at !== index)
                                        )
                                    }
                                >
                                    <Trash2 />
                                </Button>
                            </div>
                        ))}
                        <div className="flex flex-wrap items-center gap-2">
                            <Input
                                className="min-w-0 flex-1"
                                value={listUrl}
                                placeholder="https://example.com/blocklist.txt"
                                aria-label={t("lists.url")}
                                aria-invalid={listUrl.trim() !== "" && !newList.success}
                                onChange={(event) => setListUrl(event.target.value)}
                            />
                            <Select
                                className="w-40"
                                value={listCategory}
                                aria-label={t("lists.category")}
                                onValueChange={(value) => setListCategory(value as dns.DnsCategory)}
                                options={dns.DNS_CATEGORIES.map((category) => ({
                                    value: category,
                                    label: t(`categories.${category}`)
                                }))}
                            />
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                    !newList.success ||
                                    customLists.length >= dns.DNS_LIMITS.customLists
                                }
                                onClick={() => {
                                    if (!newList.success) return;
                                    setCustomLists((current) => [...current, newList.data]);
                                    setListUrl("");
                                }}
                            >
                                <Plus />
                                {t("lists.add")}
                            </Button>
                        </div>
                        {listUrl.trim() !== "" && !newList.success ? (
                            <p className="text-xs text-danger">{t("validation.invalidUrl")}</p>
                        ) : null}
                    </div>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("rules.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("rules.intro")}</p>
                </CardHeader>
                <CardBody className="grid gap-4 md:grid-cols-2">
                    <RuleField
                        label={t("rules.allow")}
                        value={allowText}
                        onChange={setAllowText}
                        bad={badAllow}
                        badText={t("validation.invalidRule")}
                    />
                    <RuleField
                        label={t("rules.deny")}
                        value={denyText}
                        onChange={setDenyText}
                        bad={badDeny}
                        badText={t("validation.invalidRule")}
                    />
                    {tooMany ? (
                        <p className="text-xs text-danger md:col-span-2">
                            {t("validation.tooMany", { max: dns.DNS_LIMITS.rules })}
                        </p>
                    ) : null}
                </CardBody>
            </Card>

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
                    <CardTitle>{t("records.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("records.intro")}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-2">
                    {records.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("records.empty")}</p>
                    ) : null}
                    {records.map((record, index) => (
                        <div
                            key={`${record.name}-${record.address}-${index}`}
                            className="flex min-w-0 items-center gap-2 text-sm"
                        >
                            <span className="min-w-0 flex-1 truncate" title={record.name}>
                                {record.name}
                            </span>
                            <code className="truncate text-xs" title={record.address}>
                                {record.address}
                            </code>
                            <Button
                                size="sm"
                                variant="ghost"
                                aria-label={t("records.remove")}
                                title={t("records.remove")}
                                onClick={() =>
                                    setRecords((current) => current.filter((_, at) => at !== index))
                                }
                            >
                                <Trash2 />
                            </Button>
                        </div>
                    ))}
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            className="min-w-0 flex-1"
                            value={recordName}
                            placeholder="nas.home"
                            aria-label={t("records.name")}
                            aria-invalid={
                                recordName.trim() !== "" &&
                                !newRecord.success &&
                                newRecord.error.issues.some((issue) => issue.path[0] === "name")
                            }
                            onChange={(event) => setRecordName(event.target.value)}
                        />
                        <Input
                            className="w-40"
                            value={recordAddress}
                            placeholder="192.168.1.20"
                            aria-label={t("records.address")}
                            aria-invalid={
                                recordAddress.trim() !== "" &&
                                !newRecord.success &&
                                newRecord.error.issues.some((issue) => issue.path[0] === "address")
                            }
                            onChange={(event) => setRecordAddress(event.target.value)}
                        />
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={
                                !newRecord.success || records.length >= dns.DNS_LIMITS.records
                            }
                            onClick={() => {
                                if (!newRecord.success) return;
                                setRecords((current) => [...current, newRecord.data]);
                                setRecordName("");
                                setRecordAddress("");
                            }}
                        >
                            <Plus />
                            {t("records.add")}
                        </Button>
                    </div>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("aliases.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("aliases.intro")}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-2">
                    {aliases.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("aliases.empty")}</p>
                    ) : null}
                    {aliases.map((alias, index) => (
                        <div
                            key={`${alias.name}-${alias.target}-${index}`}
                            className="flex min-w-0 items-center gap-2 text-sm"
                        >
                            <span className="min-w-0 flex-1 truncate" title={alias.name}>
                                {alias.name}
                            </span>
                            <code className="min-w-0 truncate text-xs" title={alias.target}>
                                {alias.target}
                            </code>
                            <Button
                                size="sm"
                                variant="ghost"
                                aria-label={t("aliases.remove")}
                                title={t("aliases.remove")}
                                onClick={() =>
                                    setAliases((current) => current.filter((_, at) => at !== index))
                                }
                            >
                                <Trash2 />
                            </Button>
                        </div>
                    ))}
                    {aliasClash.length > 0 ? (
                        <p className="text-xs text-danger-ink">
                            {t("validation.aliasClash", { names: aliasClash.join(", ") })}
                        </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            className="min-w-0 flex-1"
                            value={aliasName}
                            placeholder="media.home"
                            aria-label={t("aliases.name")}
                            aria-invalid={
                                aliasName.trim() !== "" &&
                                !newAlias.success &&
                                newAlias.error.issues.some((issue) => issue.path[0] === "name")
                            }
                            onChange={(event) => setAliasName(event.target.value)}
                        />
                        <Input
                            className="min-w-0 flex-1"
                            value={aliasTarget}
                            placeholder="nas.home"
                            aria-label={t("aliases.target")}
                            aria-invalid={
                                aliasTarget.trim() !== "" &&
                                !newAlias.success &&
                                newAlias.error.issues.some((issue) => issue.path[0] === "target")
                            }
                            onChange={(event) => setAliasTarget(event.target.value)}
                        />
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={!newAlias.success || aliases.length >= dns.DNS_LIMITS.records}
                            onClick={() => {
                                if (!newAlias.success) return;
                                setAliases((current) => [...current, newAlias.data]);
                                setAliasName("");
                                setAliasTarget("");
                            }}
                        >
                            <Plus />
                            {t("aliases.add")}
                        </Button>
                    </div>
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
                    <CardTitle>{t("forwards.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("forwards.intro")}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    {forwards.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("forwards.empty")}</p>
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {forwards.map((forward, index) => (
                                <li
                                    key={`${forward.domain}-${forward.server}-${index}`}
                                    className="flex min-w-0 items-center gap-2 rounded-md bg-muted p-2 text-sm"
                                >
                                    <span className="min-w-0 flex-1 break-all font-mono text-xs">
                                        {forward.domain}
                                    </span>
                                    <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                                        {forward.server}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={`${t("forwards.remove")}: ${forward.domain}`}
                                        title={t("forwards.remove")}
                                        onClick={() =>
                                            setForwards((current) =>
                                                current.filter((_, at) => at !== index)
                                            )
                                        }
                                    >
                                        <Trash2 />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                        <Input
                            className="sm:w-56"
                            value={forwardDomain}
                            placeholder="home.lan"
                            aria-label={t("forwards.domain")}
                            aria-invalid={forwardIssue === "invalidName"}
                            onChange={(event) => setForwardDomain(event.target.value)}
                        />
                        <Input
                            className="sm:w-56"
                            value={forwardServer}
                            placeholder="192.168.1.1"
                            aria-label={t("forwards.server")}
                            aria-invalid={forwardIssue === "invalidUpstream"}
                            onChange={(event) => setForwardServer(event.target.value)}
                        />
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={
                                !newForward.success || forwards.length >= dns.DNS_LIMITS.forwards
                            }
                            onClick={() => {
                                if (!newForward.success) return;
                                setForwards((current) => [...current, newForward.data]);
                                setForwardDomain("");
                                setForwardServer("");
                            }}
                        >
                            <Plus />
                            {t("forwards.add")}
                        </Button>
                    </div>
                    {forwardIssue ? (
                        <span className="text-xs text-danger-ink">
                            {forwardIssue === "invalidName"
                                ? t("validation.invalidDomain")
                                : t("validation.invalidForwardServer")}
                        </span>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("devices.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("devices.intro")}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    {devices.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("devices.empty")}</p>
                    ) : (
                        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                            {devices.map((device, index) => (
                                <li
                                    key={`${device.name}-${device.address}-${index}`}
                                    className="flex min-w-0 items-center gap-2 rounded-md bg-muted p-2 text-sm"
                                >
                                    <span className="min-w-0 flex-1 break-all font-medium">
                                        {device.name}
                                    </span>
                                    <span className="min-w-0 break-all text-xs text-muted-foreground">
                                        {device.address}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={`${t("devices.remove")}: ${device.name}`}
                                        title={t("devices.remove")}
                                        onClick={() =>
                                            setDevices((current) =>
                                                current.filter((_, at) => at !== index)
                                            )
                                        }
                                    >
                                        <Trash2 />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                        <Input
                            className="sm:w-56"
                            value={deviceName}
                            placeholder={t("devices.namePlaceholder")}
                            aria-label={t("devices.name")}
                            aria-invalid={deviceIssue === "invalidDeviceName"}
                            onChange={(event) => setDeviceName(event.target.value)}
                        />
                        <Input
                            className="sm:w-56"
                            value={deviceAddress}
                            placeholder="192.168.1.20"
                            aria-label={t("devices.address")}
                            aria-invalid={deviceIssue === "invalidDeviceAddress"}
                            onChange={(event) => setDeviceAddress(event.target.value)}
                        />
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={
                                !newDevice.success || devices.length >= dns.DNS_LIMITS.devices
                            }
                            onClick={() => {
                                if (!newDevice.success) return;
                                setDevices((current) => [...current, newDevice.data]);
                                setDeviceName("");
                                setDeviceAddress("");
                            }}
                        >
                            <Plus />
                            {t("devices.add")}
                        </Button>
                    </div>
                    {deviceIssue ? (
                        <span className="text-xs text-danger-ink">
                            {deviceIssue === "invalidDeviceName"
                                ? t("validation.invalidDeviceName")
                                : t("validation.invalidDeviceAddress")}
                        </span>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("groups.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("groups.intro")}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    {clientGroups.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("groups.empty")}</p>
                    ) : null}
                    {clientGroups.map((group, index) => (
                        <div
                            key={`${group.name}-${index}`}
                            className="flex min-w-0 items-start gap-2 rounded-md bg-muted p-2 text-sm"
                        >
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="truncate font-medium" title={group.name}>
                                    {group.name}
                                </span>
                                <span
                                    className="truncate text-xs text-muted-foreground"
                                    title={group.clients.join(", ")}
                                >
                                    {group.clients.join(", ")}
                                </span>
                                <span className="truncate text-xs">
                                    {group.categories.length === 0
                                        ? t("groups.nothing")
                                        : group.categories
                                              .map((category) => t(`categories.${category}`))
                                              .join(", ")}
                                </span>
                            </div>
                            <Button
                                size="sm"
                                variant="ghost"
                                aria-label={t("groups.remove")}
                                title={t("groups.remove")}
                                onClick={() =>
                                    setClientGroups((current) =>
                                        current.filter((_, at) => at !== index)
                                    )
                                }
                            >
                                <Trash2 />
                            </Button>
                        </div>
                    ))}
                    <div className="flex flex-col gap-2">
                        <Input
                            value={groupName}
                            placeholder={t("groups.namePlaceholder")}
                            aria-label={t("groups.name")}
                            onChange={(event) => setGroupName(event.target.value)}
                        />
                        <RuleField
                            label={t("groups.clients")}
                            value={groupClients}
                            onChange={setGroupClients}
                            bad={badGroupClients}
                            badText={t("validation.invalidClient")}
                            placeholder={GROUP_CLIENTS_EXAMPLE}
                        />
                        <div className="flex flex-wrap gap-x-4 gap-y-2">
                            {dns.DNS_CATEGORIES.map((category) => (
                                <label key={category} className="flex items-center gap-2 text-sm">
                                    <Switch
                                        checked={groupCategories.includes(category)}
                                        onChange={(on: boolean) =>
                                            setGroupCategories((current) =>
                                                on
                                                    ? [...current, category]
                                                    : current.filter((item) => item !== category)
                                            )
                                        }
                                    />
                                    <span>{t(`categories.${category}`)}</span>
                                </label>
                            ))}
                        </div>
                        <div>
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                    !newGroup.success ||
                                    clientGroups.length >= dns.DNS_LIMITS.clientGroups
                                }
                                onClick={() => {
                                    if (!newGroup.success) return;
                                    setClientGroups((current) => [...current, newGroup.data]);
                                    setGroupName("");
                                    setGroupClients("");
                                    setGroupCategories([]);
                                }}
                            >
                                <Plus />
                                {t("groups.add")}
                            </Button>
                        </div>
                    </div>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("schedules.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("schedules.intro")}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    {schedules.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("schedules.empty")}</p>
                    ) : null}
                    {schedules.map((schedule, index) => {
                        const lists = schedule.lists.map((list) => {
                            const name = (dns.DNS_CATEGORIES as readonly string[]).includes(list)
                                ? t(`categories.${list as dns.DnsCategory}`)
                                : list;
                            return (listed as string[]).includes(list)
                                ? name
                                : t("schedules.notOn", { name });
                        });
                        const days =
                            schedule.days.length === dns.DNS_WEEKDAYS.length
                                ? t("schedules.everyDay")
                                : schedule.days.map((day) => t(`weekdays.${day}`)).join(", ");
                        const hours = schedule.start
                            ? `${schedule.start} - ${schedule.end}`
                            : t("schedules.allDay");
                        return (
                            <div
                                key={`${schedule.lists.join(",")}-${index}`}
                                className="flex min-w-0 items-start gap-2 rounded-md bg-muted p-2 text-sm"
                            >
                                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <span className="truncate font-medium" title={lists.join(", ")}>
                                        {lists.join(", ")}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {days}, {hours}
                                    </span>
                                </div>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label={t("schedules.remove")}
                                    title={t("schedules.remove")}
                                    onClick={() =>
                                        setSchedules((current) =>
                                            current.filter((_, at) => at !== index)
                                        )
                                    }
                                >
                                    <Trash2 />
                                </Button>
                            </div>
                        );
                    })}
                    {listed.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("schedules.noLists")}</p>
                    ) : (
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1 text-sm">
                                <span>{t("schedules.lists")}</span>
                                <div className="flex flex-wrap gap-x-4 gap-y-2">
                                    {listed.map((category) => (
                                        <label
                                            key={category}
                                            className="flex items-center gap-2 text-sm"
                                        >
                                            <Switch
                                                checked={scheduleLists.includes(category)}
                                                onChange={(on: boolean) =>
                                                    setScheduleLists((current) =>
                                                        on
                                                            ? [...current, category]
                                                            : current.filter(
                                                                  (item) => item !== category
                                                              )
                                                    )
                                                }
                                            />
                                            <span>{t(`categories.${category}`)}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                            <div className="flex flex-col gap-1 text-sm">
                                <span>{t("schedules.days")}</span>
                                <div className="flex flex-wrap gap-1">
                                    {dns.DNS_WEEKDAYS.map((day) => {
                                        const on = scheduleDays.includes(day);
                                        return (
                                            <Button
                                                key={day}
                                                size="sm"
                                                variant={on ? "primary" : "outline"}
                                                aria-pressed={on}
                                                onClick={() =>
                                                    setScheduleDays((current) =>
                                                        on
                                                            ? current.filter((item) => item !== day)
                                                            : [...current, day]
                                                    )
                                                }
                                            >
                                                {t(`weekdays.${day}`)}
                                            </Button>
                                        );
                                    })}
                                </div>
                            </div>
                            <div className="flex flex-wrap items-end gap-3">
                                <label className="flex items-center gap-2 self-center text-sm">
                                    <Switch checked={scheduleWhole} onChange={setScheduleWhole} />
                                    <span>{t("schedules.whole")}</span>
                                </label>
                                {!scheduleWhole ? (
                                    <>
                                        <label className="flex flex-col gap-1 text-sm">
                                            <span>{t("schedules.from")}</span>
                                            <Input
                                                className="w-32"
                                                type="time"
                                                value={scheduleStart}
                                                aria-invalid={Boolean(scheduleIssue)}
                                                onChange={(event) =>
                                                    setScheduleStart(event.target.value)
                                                }
                                            />
                                        </label>
                                        <label className="flex flex-col gap-1 text-sm">
                                            <span>{t("schedules.to")}</span>
                                            <Input
                                                className="w-32"
                                                type="time"
                                                value={scheduleEnd}
                                                aria-invalid={Boolean(scheduleIssue)}
                                                onChange={(event) =>
                                                    setScheduleEnd(event.target.value)
                                                }
                                            />
                                        </label>
                                    </>
                                ) : null}
                                <div className="flex min-w-0 flex-col gap-1 text-sm">
                                    <span aria-hidden>{t("schedules.zone")}</span>
                                    <SearchableSelect
                                        className="w-full sm:w-64"
                                        value={timeZone}
                                        aria-label={t("schedules.zone")}
                                        onValueChange={setTimeZone}
                                        searchPlaceholder={t("schedules.zoneSearch")}
                                        emptyText={t("schedules.zoneEmpty")}
                                        options={timeZones(timeZone).map((zone) => ({
                                            value: zone,
                                            label: zone.replace(/_/g, " ")
                                        }))}
                                    />
                                </div>
                            </div>
                            {scheduleIssue ? (
                                <span className="text-xs text-danger-ink">
                                    {t(`validation.${scheduleIssue as "timePair"}`)}
                                </span>
                            ) : null}
                            <div>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={
                                        !newSchedule.success ||
                                        schedules.length >= dns.DNS_LIMITS.schedules
                                    }
                                    onClick={() => {
                                        if (!newSchedule.success) return;
                                        setSchedules((current) => [...current, newSchedule.data]);
                                        setScheduleLists([]);
                                        setScheduleDays([]);
                                    }}
                                >
                                    <Plus />
                                    {t("schedules.add")}
                                </Button>
                            </div>
                        </div>
                    )}
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
                </CardBody>
            </Card>
            <Card>
                <CardBody className="flex flex-wrap items-end justify-between gap-3">
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
                    <Button
                        onClick={save}
                        disabled={!dirty || !valid || saving}
                        aria-disabled={!dirty || !valid || saving}
                    >
                        {saving ? <Loader2 className="animate-spin" /> : null}
                        {engineExists ? t("settings.saveApply") : t("settings.save")}
                    </Button>
                </CardBody>
            </Card>
        </div>
    );
}

function RuleField({
    label,
    value,
    onChange,
    bad,
    badText,
    placeholder = "ads.example.com\n*.tracker.example\n/^ad[0-9]*\\./",
    missing = null
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    bad: readonly string[];
    badText: string;
    placeholder?: string;
    missing?: string | null;
}) {
    return (
        <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span>{label}</span>
            <Textarea
                rows={6}
                value={value}
                placeholder={placeholder}
                spellCheck={false}
                aria-invalid={bad.length > 0 || Boolean(missing)}
                onChange={(event) => onChange(event.target.value)}
                className="font-mono text-xs"
            />
            {bad.length > 0 ? (
                <span className="break-all text-xs text-danger">
                    {badText} {bad.slice(0, 3).join(", ")}
                </span>
            ) : missing ? (
                <span className="text-xs text-danger">{missing}</span>
            ) : null}
        </label>
    );
}
