"use client";

/**
 * The Network filter's Lists: the blocklists it follows, your own allow and block
 * rules, services blocked by name, and the hours a list is only on at.
 */

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Input,
    SearchableSelect,
    Select,
    Switch,
    DateInput
} from "@polaris/ui";
import * as dns from "@/lib/dns-blocker/settings";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";
import { timeZones } from "./fields";
import { DnsRulesEditor } from "./rules-editor";
import { DnsReputationCard } from "./reputation-card";
import { useDnsBlocker, useField } from "./dns-blocker-context";
import { DnsSaveBar } from "./save-bar";
import { DnsLookupCard } from "./lookup-card";
import { listLabel } from "./dns-insights";

export function DnsListsSection() {
    const t = useTranslations("dnsBlocker");
    const [sources, setSources] = useField("sources");
    const [customLists, setCustomLists] = useField("customLists");
    const [services, setServices] = useField("services");
    const { clientGroups } = useDnsBlocker().form;
    const [schedules, setSchedules] = useField("schedules");
    const [timeZone, setTimeZone] = useField("timeZone");
    const [listUrl, setListUrl] = useState("");
    const [listCategory, setListCategory] = useState<dns.DnsCategory>("ads");
    const [scheduleLists, setScheduleLists] = useState<string[]>([]);
    const [scheduleDays, setScheduleDays] = useState<dns.DnsWeekday[]>([]);
    const [scheduleWhole, setScheduleWhole] = useState(false);
    const [scheduleStart, setScheduleStart] = useState("21:00");
    const [scheduleEnd, setScheduleEnd] = useState("07:00");
    const { checks, status } = useDnsBlocker();
    const { badAllow, badDeny, tooMany } = checks;
    const newList = dns.dnsCustomListSchema.safeParse({ url: listUrl, category: listCategory });
    const listed = dns.dnsSchedulableLists({ sources, customLists, services, clientGroups });
    const newSchedule = dns.dnsScheduleSchema.safeParse({
        lists: scheduleLists.filter((list) => listed.includes(list)),
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

    return (
        <div className="flex flex-col gap-4">
            {status?.state === "blocking" ? <DnsLookupCard /> : null}
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

            <DnsRulesEditor />
            {badAllow.length > 0 || badDeny.length > 0 || tooMany ? (
                <p className="text-xs text-danger">
                    {tooMany
                        ? t("validation.tooMany", { max: dns.DNS_LIMITS.rules })
                        : `${t("validation.invalidRule")} ${[...badAllow, ...badDeny].slice(0, 3).join(", ")}`}
                </p>
            ) : null}

            <DnsReputationCard />

            <Card>
                <CardHeader>
                    <CardTitle>{t("services.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("services.intro")}</p>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                    {dns.DNS_SERVICE_GROUPS.map((group) => (
                        <div key={group} className="flex flex-col gap-2">
                            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {t(`services.groups.${group}`)}
                            </h4>
                            <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                                {dns.DNS_SERVICES.filter((service) => service.group === group).map(
                                    (service) => (
                                        <label
                                            key={service.id}
                                            className="flex min-w-0 items-center gap-2 text-sm"
                                        >
                                            <Switch
                                                checked={services.includes(service.id)}
                                                onChange={(on: boolean) =>
                                                    setServices((current) =>
                                                        on
                                                            ? [...current, service.id]
                                                            : current.filter(
                                                                  (id) => id !== service.id
                                                              )
                                                    )
                                                }
                                            />
                                            <span className="truncate" title={service.name}>
                                                {service.name}
                                            </span>
                                        </label>
                                    )
                                )}
                            </div>
                        </div>
                    ))}
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
                        const lists = schedule.lists.map((list) =>
                            listed.includes(list)
                                ? listLabel(t, list)
                                : t("schedules.notOn", { name: listLabel(t, list) })
                        );
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
                                    {listed.map((list) => (
                                        <label
                                            key={list}
                                            className="flex items-center gap-2 text-sm"
                                        >
                                            <Switch
                                                checked={scheduleLists.includes(list)}
                                                onChange={(on: boolean) =>
                                                    setScheduleLists((current) =>
                                                        on
                                                            ? [...current, list]
                                                            : current.filter(
                                                                  (item) => item !== list
                                                              )
                                                    )
                                                }
                                            />
                                            <span>{listLabel(t, list)}</span>
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
                                            <DateInput
                                                mode="time"
                                                className="w-32"
                                                value={scheduleStart}
                                                aria-invalid={Boolean(scheduleIssue)}
                                                onChange={(event) =>
                                                    setScheduleStart(event.target.value)
                                                }
                                            />
                                        </label>
                                        <label className="flex flex-col gap-1 text-sm">
                                            <span>{t("schedules.to")}</span>
                                            <DateInput
                                                mode="time"
                                                className="w-32"
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
            <DnsSaveBar />
        </div>
    );
}
