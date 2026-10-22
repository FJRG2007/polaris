/**
 * Every app Polaris releases, from the GitHub releases read when the site was
 * built: the version, its files and the guide each opens, or a plain "not
 * released yet" with the release page, never a button that implies a file.
 */

import { siteData, words } from "@/lib/site";
import { GuideFile } from "@/views/guide-file";
import type { CardTint } from "@polaris/ui/download-card";
import { Badge, CopyButton, buttonVariants } from "@polaris/ui";
import { DownloadCard, DownloadRow, DownloadRows } from "@polaris/ui/download-card";
import { fill, guideItemFor, type ProductId, type SiteLocale } from "@/data/builders";

const TINTS: Readonly<Record<ProductId, CardTint>> = {
    extension: "sky",
    streamdeck: "amber",
    companion: "violet",
    cli: "emerald",
    desktop: "slate"
};

export function DownloadsView({ locale }: { locale: SiteLocale }) {
    const t = words(locale).downloads;
    const data = siteData();
    const guide = data.locales[locale].guide;
    return (
        <>
            <div className="flex flex-col gap-1">
                <h1 className="text-3xl font-semibold tracking-tight">{t.title}</h1>
                <p className="text-muted-foreground">{t.intro}</p>
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
                {data.downloads.map((entry) => (
                    <DownloadCard
                        key={entry.product}
                        id={entry.product}
                        tint={TINTS[entry.product]}
                        title={t.products[entry.product]}
                        description={t.about[entry.product]}
                    >
                        {entry.product === "cli" ? (
                            <DownloadRows>
                                {[data.cli.unix, data.cli.windows].map((command) => (
                                    <DownloadRow
                                        key={command}
                                        mark={<span className="text-xs">$</span>}
                                        name={command.startsWith("irm") ? "PowerShell" : "Terminal"}
                                    >
                                        <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                                            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-xs">
                                                {command}
                                            </code>
                                            <CopyButton value={command} />
                                        </div>
                                    </DownloadRow>
                                ))}
                                <p className="pt-2 text-xs text-muted-foreground">{t.cliHint}</p>
                            </DownloadRows>
                        ) : null}
                        {entry.released ? (
                            <>
                                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Badge variant="neutral">
                                        {fill(t.version, { version: entry.version })}
                                    </Badge>
                                    <a className="underline" href={entry.url}>
                                        {t.notes}
                                    </a>
                                </p>
                                {entry.product === "cli" ? null : (
                                    <DownloadRows>
                                        {entry.files.map((file) => (
                                            <DownloadRow
                                                key={file.url}
                                                mark={
                                                    <span className="text-[10px] uppercase">
                                                        {file.name.split(".").pop()}
                                                    </span>
                                                }
                                                name={file.name}
                                                action={
                                                    <GuideFile
                                                        item={guideItemFor(
                                                            entry.product,
                                                            file.name
                                                        )}
                                                        href={file.url}
                                                        fileName={file.name}
                                                        label={t.download}
                                                        guide={guide}
                                                    />
                                                }
                                            />
                                        ))}
                                    </DownloadRows>
                                )}
                            </>
                        ) : (
                            <div className="flex flex-col gap-2">
                                <p className="text-sm text-muted-foreground">
                                    <Badge variant="neutral">{t.none}</Badge> {t.noneHint}
                                </p>
                                <a
                                    className={`${buttonVariants({ variant: "secondary", size: "sm" })} self-start`}
                                    href={entry.url}
                                >
                                    {t.releases}
                                </a>
                            </div>
                        )}
                    </DownloadCard>
                ))}
            </div>
        </>
    );
}
