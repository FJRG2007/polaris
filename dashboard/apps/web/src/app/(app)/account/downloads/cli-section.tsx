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
 * Its own component, like the extension's, so the page stays a list of cards.
 */

import { Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { PlatformSelect } from "@/components/platform-select";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Card, CardBody, CardHeader, CardTitle, Skeleton } from "@polaris/ui";
import { cliInstallLine, cliLoginLine } from "@/lib/cli/install-line";
import { detectPlatform, type InstallPlatform } from "@/lib/install-platform";

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

    const install = cliInstallLine(platform, repo);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Terminal className="size-4" />
                    {t("downloads.cli.title")}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 text-sm">
                <p className="text-muted-foreground">{t("downloads.cli.description")}</p>

                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">{t("downloads.cli.install")}</p>
                        <PlatformSelect
                            className="w-44"
                            value={platform}
                            label={t("downloads.cli.system")}
                            onChange={setPlatform}
                        />
                    </div>
                    <CommandLine command={install.command} />
                    <p className="text-xs text-muted-foreground">
                        {t("downloads.cli.hint", { shell: install.shell })}
                    </p>
                </div>

                <div className="flex flex-col gap-2">
                    <p className="font-medium">{t("downloads.cli.signIn")}</p>
                    {origin ? (
                        <CommandLine command={cliLoginLine(origin)} />
                    ) : (
                        <Skeleton className="h-9 w-full" />
                    )}
                    <p className="text-xs text-muted-foreground">{t("downloads.cli.signInHint")}</p>
                </div>

                <div className="flex flex-col gap-2">
                    <p className="font-medium">{t("downloads.cli.next")}</p>
                    {/* i18n-ignore commands, typed as they are */}
                    <CommandLine command="plr projects" />
                </div>

                <p className="border-t border-border/60 pt-4 text-xs text-muted-foreground">
                    {t("downloads.cli.server")}
                </p>
            </CardBody>
        </Card>
    );
}
