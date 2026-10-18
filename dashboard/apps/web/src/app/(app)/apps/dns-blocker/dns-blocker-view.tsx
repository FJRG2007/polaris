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

/** States in which a DNS server of ours exists. */
const ENGINE_STATES: readonly DnsBlockerState[] = ["blocking", "starting", "portHeld", "conflict"];

export function DnsBlockerView({ initial }: { initial: dns.DnsSettings }) {
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

    // While the server is coming up, look again on its own a few times.
    useEffect(() => {
        if (status?.state !== "starting") return;
        const timer = setTimeout(check, 4000);
        return () => clearTimeout(timer);
    }, [status, check]);

    const badAllow = rejected(allowText, dns.normalizeDnsRule);
    const badDeny = rejected(denyText, dns.normalizeDnsRule);
    const badUpstreams = upstream === "custom" ? rejected(upstreamText, dns.normalizeUpstream) : [];
    const hours = Number(refreshHours);
    const hoursValid = Number.isInteger(hours) && hours >= 1 && hours <= 168;
    const customEmpty = upstream === "custom" && lines(upstreamText).length === 0;

    const draft: dns.DnsSettings = useMemo(
        () => ({
            sources,
            customLists,
            allow: lines(allowText).map((line) => dns.normalizeDnsRule(line) ?? line),
            deny: lines(denyText).map((line) => dns.normalizeDnsRule(line) ?? line),
            upstream,
            customUpstreams: upstream === "custom" ? lines(upstreamText) : [],
            records,
            refreshHours: hours
        }),
        [sources, customLists, allowText, denyText, upstream, upstreamText, records, hours]
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
        !customEmpty &&
        !tooMany;

    const newList = dns.dnsCustomListSchema.safeParse({ url: listUrl, category: listCategory });
    const newRecord = dns.dnsRecordSchema.safeParse({ name: recordName, address: recordAddress });

    function save(): void {
        setNotice(null);
        startSaving(async () => {
            const result = await saveDnsSettingsAction(draft);
            if (result.error) {
                setNotice({ tone: "error", text: result.error });
                return;
            }
            setSaved(draft);
            setNotice({ tone: "ok", text: t("settings.saved") });
            if (status && ENGINE_STATES.includes(status.state)) check();
        });
    }

    function switchTo(on: boolean): void {
        setNotice(null);
        startSwitching(async () => {
            const result = on ? await turnOnDnsBlockerAction() : await turnOffDnsBlockerAction();
            if (result.error) setNotice({ tone: "error", text: result.error });
            check();
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
                            <Badge variant={STATE_TONE[state]}>{t(`states.${state}.label`)}</Badge>
                        ) : null}
                    </div>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={check}
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
                                {t(`states.${status.state}.body`, {
                                    address: status.address ?? ""
                                })}
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
                                {state === "portHeld" || state === "conflict" ? (
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
                            <Button size="sm" variant="outline" onClick={check} disabled={checking}>
                                {t("actions.retry")}
                            </Button>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2" aria-busy="true">
                            <Skeleton className="h-4 w-3/4" />
                            <Skeleton className="h-8 w-28" />
                        </div>
                    )}
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
                    <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
                        <li>{t("router.step1")}</li>
                        <li>{t("router.step2", { address: status?.address ?? "-" })}</li>
                        <li>{t("router.step3")}</li>
                        <li>{t("router.step4")}</li>
                    </ol>
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
