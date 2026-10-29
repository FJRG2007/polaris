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
 * The install line is shown for one system at a time, the reader's own first,
 * with the same system picker as every other install line on the page: somebody
 * setting it up on another machine picks that one.
 */

import { Skeleton } from "../../index";
import { Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { InstallLine } from "./install-line";
import { TerminalPreview } from "./download-previews";
import { CopyButton } from "../../index";
import { useTranslations } from "../../i18n";
import { DownloadCard } from "../download-card";
import { useInstallPlatform } from "./platform-select";
import { cliInstallLine, cliLoginLine } from "./cli-install-line";

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
    const [platform, setPlatform] = useInstallPlatform();
    const [origin, setOrigin] = useState(serverUrl ?? "");

    useEffect(() => {
        if (!serverUrl) setOrigin(window.location.origin);
    }, [serverUrl]);

    const line = cliInstallLine(platform, repo);

    return (
        <DownloadCard
            id="cli"
            tint="emerald"
            icon={<Terminal className="size-4 shrink-0" />}
            title={t("downloads.cli.title")}
            description={t("downloads.cli.description")}
            preview={<TerminalPreview />}
        >
            <InstallLine
                title={t("downloads.cli.install")}
                systemLabel={t("downloads.command.system")}
                platform={platform}
                onPlatformChange={setPlatform}
                command={line.command}
                hint={t("downloads.cli.hint", { shell: line.shell })}
            />

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
