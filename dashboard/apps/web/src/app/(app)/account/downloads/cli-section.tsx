"use client";

/**
 * The command-line client on the downloads screen: the official line that
 * installs it for the reader's system, the one that signs it in to this Polaris,
 * and a first command to try.
 *
 * Installed the way the extension is - from the project's GitHub releases - and
 * pointed at this Polaris afterwards, so the install line is the same on every
 * deployment and only the sign-in line carries this one's address: the one it is
 * configured to be reached at, or the address this page is open on when none is.
 *
 * Both install lines are rows of their own, the reader's system first: somebody
 * may be setting it up on a machine that is not the one they are reading on, and
 * two lines read faster than a picker that hides one of them.
 */

import { Skeleton } from "@polaris/ui";
import { Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { TerminalPreview } from "./download-previews";
import { CopyButton } from "@/components/copy-button";
import { SystemMark } from "@/components/client-marks";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DownloadCard, DownloadRow, DownloadRows } from "@polaris/ui/download-card";
import { cliInstallLine, cliLoginLine } from "@/lib/cli/install-line";
import { detectPlatform, PLATFORM_LABELS, type InstallPlatform } from "@/lib/install-platform";

/** A command on a line of its own, with the button that copies it. */
function CommandLine({ command }: { command: string }) {
    return (
        <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-xs text-foreground">
                {command}
            </code>
            <CopyButton value={command} />
        </div>
    );
}

export function CliSection({
    repo,
    serverUrl
}: {
    /** The GitHub repository this deployment updates from. */
    repo: string;
    /** This Polaris's configured address, or null to use the one the page is on. */
    serverUrl: string | null;
}) {
    const t = useTranslations("account");
    // Read in an effect: this renders on the server too, where there is no
    // navigator and no address bar, and seeding from them would hydrate markup
    // the HTML does not contain. Only a sign-in line with no configured address
    // waits, as a skeleton of its own size.
    const [platform, setPlatform] = useState<InstallPlatform>("linux");
    const [origin, setOrigin] = useState(serverUrl ?? "");

    useEffect(() => {
        setPlatform(detectPlatform(navigator.userAgent));
        if (!serverUrl) setOrigin(window.location.origin);
    }, [serverUrl]);

    const unix = cliInstallLine("linux", repo);
    const windows = cliInstallLine("windows", repo);
    const rows = [
        {
            key: "unix",
            line: unix,
            detail: t("downloads.cli.unixSystems"),
            mark: (
                <span className="flex items-center gap-0.5">
                    <SystemMark os={PLATFORM_LABELS.macos} className="size-3.5" />
                    <SystemMark os={PLATFORM_LABELS.linux} className="size-3.5" />
                </span>
            )
        },
        {
            key: "windows",
            line: windows,
            detail: PLATFORM_LABELS.windows,
            mark: <SystemMark os={PLATFORM_LABELS.windows} />
        }
    ];
    // The reader's own system first.
    if (platform === "windows") rows.reverse();

    return (
        <DownloadCard
            id="cli"
            tint="emerald"
            icon={<Terminal className="size-4 shrink-0" />}
            title={t("downloads.cli.title")}
            description={t("downloads.cli.description")}
            preview={<TerminalPreview />}
        >
            <div className="flex min-w-0 flex-col gap-2">
                <DownloadRows label={t("downloads.cli.install")}>
                    {rows.map((row) => (
                        <DownloadRow
                            key={row.key}
                            mark={row.mark}
                            name={row.line.shell}
                            detail={row.detail}
                        >
                            <CommandLine command={row.line.command} />
                        </DownloadRow>
                    ))}
                </DownloadRows>
                <p className="text-xs text-muted-foreground">{t("downloads.cli.hint")}</p>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
                <p className="text-xs font-medium text-muted-foreground">
                    {t("downloads.cli.signIn")}
                </p>
                {origin ? (
                    <CommandLine command={cliLoginLine(origin)} />
                ) : (
                    <Skeleton className="h-9 w-full" />
                )}
                <p className="text-xs text-muted-foreground">{t("downloads.cli.signInHint")}</p>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
                <p className="text-xs font-medium text-muted-foreground">
                    {t("downloads.cli.next")}
                </p>
                {/* i18n-ignore commands, typed as they are */}
                <CommandLine command="plr projects" />
            </div>

            <p className="text-xs text-muted-foreground">{t("downloads.cli.server")}</p>
        </DownloadCard>
    );
}
