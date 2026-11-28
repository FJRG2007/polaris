"use client";

/**
 * The Network filter's Local DNS: names it answers itself, aliases of them, and
 * domains asked of another server. Each is a two-column list that adds through
 * its header button and a dialog.
 */

import { Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    useResetOnOpen
} from "@polaris/ui";
import * as dns from "@/lib/dns-blocker/settings";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useDnsBlocker, useField } from "./dns-blocker-context";
import { DnsSaveBar } from "./save-bar";

/** What a pair dialog's two typed values parse to: the row, or which field is wrong. */
type Parsed<T> = { row: T | null; wrong: 0 | 1 | null; issue: string | null };

/** Runs a two-field schema, and says which field is wrong only once something is typed in it. */
function parsePair<T>(
    result: { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } },
    keys: [string, string],
    values: [string, string]
): Parsed<T> {
    if (result.success) return { row: result.data, wrong: null, issue: null };
    const issue = result.error.issues.find((entry) => {
        const at = keys.indexOf(String(entry.path[0]));
        return at >= 0 && (values[at] ?? "").trim() !== "";
    });
    if (!issue) return { row: null, wrong: null, issue: null };
    return { row: null, wrong: keys.indexOf(String(issue.path[0])) as 0 | 1, issue: issue.message };
}

export function DnsLocalSection() {
    const t = useTranslations("dnsBlocker");
    const [records, setRecords] = useField("records");
    const [aliases, setAliases] = useField("aliases");
    const [forwards, setForwards] = useField("forwards");
    const { aliasClash } = useDnsBlocker().checks;

    return (
        <div className="flex flex-col gap-4">
            <PairCard
                section="records"
                rows={records.map((record) => [record.name, record.address] as const)}
                headers={[t("records.name"), t("records.address")]}
                placeholders={["nas.home", "192.168.1.20"]}
                full={records.length >= dns.DNS_LIMITS.records}
                parse={(values) =>
                    parsePair(
                        dns.dnsRecordSchema.safeParse({ name: values[0], address: values[1] }),
                        ["name", "address"],
                        values
                    )
                }
                onAdd={(row) => setRecords((current) => [...current, row])}
                onRemove={(index) => setRecords((current) => current.filter((_, at) => at !== index))}
            />
            <PairCard
                section="aliases"
                rows={aliases.map((alias) => [alias.name, alias.target] as const)}
                headers={[t("aliases.name"), t("aliases.target")]}
                placeholders={["media.home", "nas.home"]}
                full={aliases.length >= dns.DNS_LIMITS.records}
                parse={(values) =>
                    parsePair(
                        dns.dnsAliasSchema.safeParse({ name: values[0], target: values[1] }),
                        ["name", "target"],
                        values
                    )
                }
                onAdd={(row) => setAliases((current) => [...current, row])}
                onRemove={(index) => setAliases((current) => current.filter((_, at) => at !== index))}
                notice={
                    aliasClash.length > 0 ? (
                        <p className="text-xs text-danger-ink">
                            {t("validation.aliasClash", { names: aliasClash.join(", ") })}
                        </p>
                    ) : null
                }
            />
            <PairCard
                section="forwards"
                rows={forwards.map((forward) => [forward.domain, forward.server] as const)}
                headers={[t("forwards.domain"), t("forwards.server")]}
                placeholders={["home.lan", "192.168.1.1"]}
                full={forwards.length >= dns.DNS_LIMITS.forwards}
                parse={(values) =>
                    parsePair(
                        dns.dnsForwardSchema.safeParse({ domain: values[0], server: values[1] }),
                        ["domain", "server"],
                        values
                    )
                }
                issueText={(issue) =>
                    issue === "invalidName" ? t("validation.invalidDomain") : t("validation.invalidForwardServer")
                }
                onAdd={(row) => setForwards((current) => [...current, row])}
                onRemove={(index) => setForwards((current) => current.filter((_, at) => at !== index))}
            />
            <DnsSaveBar />
        </div>
    );
}

/** One list of two-value rows (a name and where it points), with its add dialog. */
function PairCard<T>({
    section,
    rows,
    headers,
    placeholders,
    full,
    parse,
    issueText,
    onAdd,
    onRemove,
    notice = null
}: {
    section: "records" | "aliases" | "forwards";
    rows: readonly (readonly [string, string])[];
    headers: [string, string];
    placeholders: [string, string];
    full: boolean;
    parse: (values: [string, string]) => Parsed<T>;
    issueText?: (issue: string) => string;
    onAdd: (row: T) => void;
    onRemove: (index: number) => void;
    notice?: ReactNode;
}) {
    const t = useTranslations("dnsBlocker");
    const [open, setOpen] = useState(false);
    const [values, setValues] = useState<[string, string]>(["", ""]);
    useResetOnOpen(open, () => {
        setValues(["", ""]);
    });
    const parsed = parse(values);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!parsed.row) return;
        onAdd(parsed.row);
        setValues(["", ""]);
        setOpen(false);
    };

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <CardTitle>{t(`${section}.title`)}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t(`${section}.intro`)}</p>
                </div>
                <Button
                    size="sm"
                    disabled={full}
                    title={full ? t("devices.full") : undefined}
                    onClick={() => setOpen(true)}
                >
                    <Plus className="size-4" />
                    {t(`${section}.add`)}
                </Button>
            </CardHeader>
            <CardBody className="flex flex-col gap-2">
                {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t(`${section}.empty`)}</p>
                ) : (
                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full text-sm">
                            <thead className="bg-surface/60 text-start text-xs text-muted-foreground">
                                <tr>
                                    {headers.map((header) => (
                                        <th key={header} scope="col" className="w-1/2 px-3 py-2 text-start font-medium">
                                            {header}
                                        </th>
                                    ))}
                                    <th scope="col" className="px-3 py-2">
                                        <span className="sr-only">{t("devices.actions")}</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(([first, second], index) => (
                                    <tr key={`${first}-${second}-${index}`} className="border-t border-border">
                                        <td className="max-w-0 px-3 py-2 align-middle">
                                            <span className="block truncate" title={first}>
                                                {first}
                                            </span>
                                        </td>
                                        <td className="max-w-0 px-3 py-2 align-middle">
                                            <code className="block truncate text-xs" title={second}>
                                                {second}
                                            </code>
                                        </td>
                                        <td className="px-3 py-2 align-middle">
                                            <span className="flex justify-end">
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    aria-label={`${t(`${section}.remove`)}: ${first}`}
                                                    title={t(`${section}.remove`)}
                                                    onClick={() => onRemove(index)}
                                                >
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {notice}
            </CardBody>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t(`${section}.addTitle`)}</DialogTitle>
                        <DialogDescription>{t(`${section}.intro`)}</DialogDescription>
                    </DialogHeader>
                    <form className="flex flex-col gap-3" onSubmit={submit}>
                        {headers.map((header, at) => (
                            <Input
                                key={header}
                                autoFocus={at === 0}
                                value={values[at]}
                                placeholder={placeholders[at]}
                                aria-label={header}
                                aria-invalid={parsed.wrong === at}
                                onChange={(event) => {
                                    const next: [string, string] = [...values];
                                    next[at] = event.target.value;
                                    setValues(next);
                                }}
                            />
                        ))}
                        {parsed.issue && issueText ? (
                            <span className="text-xs text-danger-ink">{issueText(parsed.issue)}</span>
                        ) : null}
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                                {t("devices.cancel")}
                            </Button>
                            <Button type="submit" disabled={!parsed.row}>
                                {t(`${section}.add`)}
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
