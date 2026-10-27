"use client";

/**
 * The Network filter's Local DNS: names it answers itself, aliases of them, and
 * domains asked of another server.
 */

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";
import * as dns from "@/lib/dns-blocker/settings";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useDnsBlocker, useField } from "./dns-blocker-context";
import { DnsSaveBar } from "./save-bar";

export function DnsLocalSection() {
    const t = useTranslations("dnsBlocker");
    const [records, setRecords] = useField("records");
    const [aliases, setAliases] = useField("aliases");
    const [forwards, setForwards] = useField("forwards");
    const [recordName, setRecordName] = useState("");
    const [recordAddress, setRecordAddress] = useState("");
    const [aliasName, setAliasName] = useState("");
    const [aliasTarget, setAliasTarget] = useState("");
    const [forwardDomain, setForwardDomain] = useState("");
    const [forwardServer, setForwardServer] = useState("");
    const { aliasClash } = useDnsBlocker().checks;
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

    return (
        <div className="flex flex-col gap-4">
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
                            className="min-w-0 flex-1 basis-64"
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
            <DnsSaveBar />
        </div>
    );
}
