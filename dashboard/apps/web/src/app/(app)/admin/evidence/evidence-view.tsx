"use client";

/**
 * The instance's controls, as an auditor asks for them, and the copy to hand over.
 *
 * The header and the export button are drawn at once; the areas arrive from
 * /api/admin/evidence after the screen has painted, and only they are sketched
 * while it answers. A revisit paints the last reading straight away.
 *
 * Exporting reads everything again, at one moment, and comes back with both
 * files and the hash of the JSON. They are held here rather than downloaded on
 * the spot, so the hash can be read and copied beside the buttons that save them.
 */

import { useState } from "react";
import { downloadBytes } from "@/lib/download";
import { Download, Loader2 } from "lucide-react";
import { EvidenceSectionCard } from "./evidence-section";
import { useDisplayFormat } from "@/components/display-format";
import type { EvidenceReport } from "@/lib/compliance/evidence";
import { useLiveResource } from "@/components/use-live-resource";
import type { EvidenceExport } from "@/lib/compliance/evidence-export";
import { Button, Card, CardBody, CopyButton, PageHeader, Skeleton, useToast } from "@polaris/ui";

/** The facts are configuration; they move when somebody changes a setting. */
const POLL_MS = 5 * 60_000;

/** Save one of the export's files. */
function save(file: { name: string; body: string }, type: string): void {
    downloadBytes(new Blob([file.body], { type }), file.name);
}

export function EvidenceView() {
    const format = useDisplayFormat();
    const toast = useToast();
    const [exporting, setExporting] = useState(false);
    const [exported, setExported] = useState<EvidenceExport | null>(null);
    const { data, loading, error, refresh } = useLiveResource<EvidenceReport>({
        url: "/api/admin/evidence",
        cacheKey: "admin.evidence",
        intervalMs: POLL_MS,
        select: (body) => body as EvidenceReport
    });
    const formatDate = (iso: string) => format.dateTime(iso);

    const exportNow = async () => {
        setExporting(true);
        try {
            const res = await fetch("/api/admin/evidence/export", { method: "POST" });
            const body: unknown = await res.json().catch(() => null);
            if (!res.ok || !body || typeof body !== "object" || !("sha256" in body)) {
                const message =
                    body && typeof body === "object" && "error" in body
                        ? String(body.error)
                        : "The export did not work";
                toast.show({ title: message });
                return;
            }
            setExported(body as EvidenceExport);
            toast.show({ title: "Exported, and recorded in Activity." });
            refresh();
        } catch {
            toast.show({
                title: "Polaris could not be reached. Check the connection and try again."
            });
        } finally {
            setExporting(false);
        }
    };

    return (
        <>
            <PageHeader
                title="Evidence"
                description="The controls in force on this Polaris, read from its settings, with where each is set and who last changed it."
                actions={
                    <Button size="sm" onClick={() => void exportNow()} disabled={exporting}>
                        {exporting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                        {exporting ? "Exporting" : "Export"}
                    </Button>
                }
            />
            <div className="flex flex-col gap-4">
                <p className="text-xs text-muted-foreground">
                    Polaris is not certified against SOC 2 or ISO 27001. Certification is an audit
                    of the organization that runs it; this is the evidence of how this instance is
                    configured.
                </p>

                {exported ? (
                    <Card>
                        <CardBody className="flex flex-col gap-3 text-sm">
                            <p>
                                Exported {format.dateTime(exported.generatedAt)}. The JSON&apos;s
                                SHA-256 is recorded in Activity, so a copy can be checked later.
                            </p>
                            <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    SHA-256
                                </span>
                                <code
                                    className="min-w-0 flex-1 truncate font-mono text-xs"
                                    title={exported.sha256}
                                >
                                    {exported.sha256}
                                </code>
                                <CopyButton value={exported.sha256} label="the SHA-256" />
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => save(exported.json, "application/json")}
                                >
                                    <Download className="size-4" aria-hidden />
                                    JSON
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => save(exported.markdown, "text/markdown")}
                                >
                                    <Download className="size-4" aria-hidden />
                                    Printable report
                                </Button>
                            </div>
                        </CardBody>
                    </Card>
                ) : null}

                {data ? (
                    <>
                        <p className="text-xs text-muted-foreground">
                            Read {format.dateTime(data.generatedAt)} from {data.instance.url}
                            {data.instance.build ? `, build ${data.instance.build}` : ""}.
                        </p>
                        {data.sections.map((section) => (
                            <EvidenceSectionCard
                                key={section.id}
                                section={section}
                                formatDate={formatDate}
                            />
                        ))}
                        <Card>
                            <CardBody className="flex flex-col gap-2 text-sm">
                                <h2 className="text-[0.8125rem] font-semibold tracking-tight">
                                    Outside what Polaris can see
                                </h2>
                                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                                    {data.outsidePolaris.map((item) => (
                                        <li key={item}>{item}</li>
                                    ))}
                                </ul>
                            </CardBody>
                        </Card>
                    </>
                ) : loading ? (
                    <div
                        className="flex flex-col gap-4"
                        aria-busy="true"
                        aria-label="Reading the evidence"
                    >
                        {[0, 1, 2].map((index) => (
                            <Skeleton key={index} className="h-56 w-full rounded-lg" />
                        ))}
                    </div>
                ) : (
                    <Card>
                        <CardBody className="flex flex-wrap items-center justify-between gap-3 text-sm">
                            <p className="text-danger">
                                {error ?? "The evidence could not be read."}
                            </p>
                            <Button size="sm" variant="outline" onClick={refresh}>
                                Try again
                            </Button>
                        </CardBody>
                    </Card>
                )}
            </div>
        </>
    );
}
