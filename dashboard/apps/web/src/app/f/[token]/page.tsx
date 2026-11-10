/**
 * Public page of a quick-send transfer. The token is the credential; nothing
 * else is asked of the visitor.
 *
 * Opening this page spends nothing - every download is a button that posts, so a
 * link previewer or a mail scanner fetching the address leaves a one-time file
 * for the person it was sent to. File names are rendered as text by React and
 * never as markup.
 */

import { getSession } from "@/lib/session";
import { formatBytes } from "@polaris/core";
import { FileIcon } from "lucide-react";
import { QuickSendDownload } from "./download-button";
import { getTranslations } from "@/lib/i18n/request";
import { rateLimit } from "@/lib/rate-limit-service";
import { clientIp, hashForLog } from "@/lib/request-context";
import { openTransfer } from "@/lib/disposable-transfer-service";
import { LinkUnavailable, PublicShell } from "@/components/public-shell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { robots: { index: false, follow: false } };

export default async function QuickSendPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const t = await getTranslations("drive");
    const signedIn = Boolean((await getSession())?.user);

    const address = hashForLog(await clientIp()) ?? "unknown";
    if (!(await rateLimit(`quick-send-page:${address}`, 60, 60_000)).ok) {
        return <LinkUnavailable signedIn={signedIn} message={t("disposable.public.slowDown")} />;
    }

    const opened = await openTransfer(token);
    if (!opened.ok) {
        return (
            <LinkUnavailable
                signedIn={signedIn}
                title={t("disposable.public.goneTitle")}
                message={t(`disposable.public.gone.${opened.reason}`)}
            />
        );
    }

    return (
        <PublicShell signedIn={signedIn}>
            <div className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-4">
                <div className="min-w-0">
                    <h1 className="text-lg font-semibold tracking-tight">
                        {t("disposable.public.title", { count: opened.files.length })}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {t("disposable.public.expires", {
                            date: opened.expiresAt.toISOString().slice(0, 16).replace("T", " ")
                        })}{" "}
                        UTC
                    </p>
                    {opened.note ? (
                        <p className="mt-2 whitespace-pre-wrap break-words text-sm">{opened.note}</p>
                    ) : null}
                </div>
                <ul className="flex min-w-0 flex-col divide-y divide-border rounded-md border border-border">
                    {opened.files.map((file) => (
                        <li key={file.id} className="flex min-w-0 items-center gap-3 p-3">
                            <FileIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium" title={file.name}>
                                    {file.name}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {formatBytes(file.size)}
                                    {file.downloadsLeft !== null
                                        ? ` - ${t("disposable.downloadsLeft", { count: file.downloadsLeft })}`
                                        : ""}
                                </p>
                            </div>
                            <QuickSendDownload
                                action={`/api/f/${encodeURIComponent(token)}/${file.id}`}
                                label={t("disposable.public.download")}
                                namedLabel={t("disposable.public.downloadNamed", { name: file.name })}
                                preparing={t("disposable.public.preparing")}
                            />
                        </li>
                    ))}
                </ul>
                <p className="text-xs text-muted-foreground">{t("disposable.public.hint")}</p>
            </div>
        </PublicShell>
    );
}
