"use client";

/**
 * "Is this name blocked, and by what?": one name asked of the running engine
 * the way a device with no group of its own would ask it, with allow or block
 * offered from the answer.
 */

import Link from "next/link";
import { useState } from "react";
import { listLabel, logHref } from "./dns-insights";
import { Loader2, Search } from "lucide-react";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useDnsBlocker } from "./dns-blocker-context";
import { dnsLookupAction, ruleFromLogAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { lookupSchema, type DnsLookup } from "@/lib/dns-blocker/query-log";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";

export function DnsLookupCard() {
    const t = useTranslations("dnsBlocker");
    const { recheck, adoptRules } = useDnsBlocker();
    const [domain, setDomain] = useState("");
    const [lookup, setLookup] = useState<DnsLookup | null>(null);
    const [asking, setAsking] = useState(false);
    const [ruling, setRuling] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const parsed = lookupSchema.safeParse({ domain });
    // An empty field is not finished yet, not wrong.
    const invalid = domain.trim() !== "" && !parsed.success;

    const ask = () => {
        if (!parsed.success || asking) return;
        setAsking(true);
        setError(null);
        setNotice(null);
        void dnsLookupAction({ domain: parsed.data.domain }).then((result) => {
            setAsking(false);
            if (result.error !== undefined) {
                setLookup(null);
                setError(result.error);
                return;
            }
            setLookup(result.lookup);
        });
    };

    const rule = (name: string, list: "allow" | "deny") => {
        setRuling(true);
        setNotice(null);
        void ruleFromLogAction({ domain: name, list }).then((result) => {
            setRuling(false);
            if (result.error !== undefined) {
                setError(result.error);
                return;
            }
            setError(null);
            setLookup(null);
            setNotice(
                list === "allow"
                    ? t("insights.nowAllowed", { domain: name })
                    : t("insights.nowBlocked", { domain: name })
            );
            adoptRules(result.settings);
            recheck();
        });
    };

    const blocked = lookup?.outcome === "blocked";
    const answeredBy = !lookup
        ? ""
        : blocked
          ? listLabel(t, lookup.list)
          : ["cache", "local", "other"].includes(lookup.via)
            ? t(`insights.via.${lookup.via}` as NamespaceKey<"dnsBlocker">)
            : lookup.via;

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("lookup.title")}</CardTitle>
                <p className="text-xs text-muted-foreground">{t("lookup.intro")}</p>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <form
                    className="flex min-w-0 flex-col gap-2 sm:flex-row"
                    onSubmit={(event) => {
                        event.preventDefault();
                        ask();
                    }}
                >
                    <Input
                        className="min-w-0 flex-1"
                        value={domain}
                        onChange={(event) => setDomain(event.target.value)}
                        placeholder="ads.example.com"
                        aria-label={t("lookup.domain")}
                        aria-invalid={invalid || undefined}
                        spellCheck={false}
                        autoCapitalize="none"
                    />
                    <Button type="submit" disabled={!parsed.success || asking}>
                        {asking ? (
                            <Loader2 className="size-4 shrink-0 animate-spin" />
                        ) : (
                            <Search className="size-4 shrink-0" />
                        )}
                        {t("lookup.ask")}
                    </Button>
                </form>
                {invalid ? <p className="text-sm text-danger-ink">{t("lookup.invalid")}</p> : null}
                {error ? <p className="text-sm text-danger-ink">{error}</p> : null}
                {notice ? <p className="text-sm text-success-ink">{notice}</p> : null}
                {lookup ? (
                    <div className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <Badge variant={blocked ? "danger" : "success"}>
                                {blocked ? t("lookup.blocked") : t("lookup.allowed")}
                            </Badge>
                            <span
                                className="min-w-0 truncate font-mono text-sm"
                                title={lookup.domain}
                            >
                                {lookup.domain}
                            </span>
                        </div>
                        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                            <dt className="text-muted-foreground">
                                {blocked ? t("lookup.byList") : t("lookup.answeredBy")}
                            </dt>
                            <dd className="min-w-0 truncate" title={answeredBy}>
                                {answeredBy}
                            </dd>
                            <dt className="text-muted-foreground">{t("lookup.answer")}</dt>
                            <dd className="min-w-0 truncate font-mono" title={lookup.response}>
                                {lookup.response || lookup.returnCode}
                            </dd>
                        </dl>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={ruling}
                                onClick={() => rule(lookup.domain, blocked ? "allow" : "deny")}
                            >
                                {ruling ? (
                                    <Loader2 className="size-4 shrink-0 animate-spin" />
                                ) : null}
                                {blocked ? t("lookup.allow") : t("lookup.block")}
                            </Button>
                            <Button asChild size="sm" variant="ghost">
                                <Link href={logHref({ search: lookup.domain })}>
                                    {t("lookup.inLog")}
                                </Link>
                            </Button>
                        </div>
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}
