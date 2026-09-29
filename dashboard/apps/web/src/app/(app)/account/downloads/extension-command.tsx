"use client";

/**
 * Installing the extension in one line - and updating it with the same one.
 *
 * Offered above the manual steps rather than instead of them. The steps are what
 * somebody follows when they want to see what is happening, or when the script
 * cannot run where they are; this is for everybody else, and it is the only way
 * on this screen that makes a later version a refresh arrow rather than the
 * whole install again.
 *
 * The line is shown for one system at a time and stays a picker, like the
 * browser below it: the reader may be preparing this for a machine that is not
 * the one they are reading on.
 */

import { Select } from "@polaris/ui";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { INSTALL_OSES, detectOs, installCommand, type InstallOs } from "@/lib/install-command";

export function ExtensionCommand({ repo }: { repo: string }) {
    // Detected in an effect rather than during render: this is rendered on the
    // server too, where there is no navigator, and seeding from one would have
    // the browser hydrate something the HTML does not contain.
    const t = useTranslations("account");
    const [os, setOs] = useState<InstallOs>("unix");

    useEffect(() => {
        setOs(detectOs(navigator.userAgent));
    }, []);

    const chosen = installCommand(os, repo);

    return (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{t("downloads.command.title")}</p>
                <Select
                    className="w-44"
                    value={os}
                    aria-label={t("downloads.command.system")}
                    onValueChange={(value) => setOs(value as InstallOs)}
                    options={INSTALL_OSES.map((entry) => ({
                        value: entry,
                        label: entry === "unix" ? t("downloads.command.unix") : installCommand(entry, repo).label
                    }))}
                />
            </div>

            <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-xs text-foreground">
                    {chosen.command}
                </code>
                <CopyButton value={chosen.command} />
            </div>

            <p className="text-xs text-muted-foreground">
                {t("downloads.command.hint", { shell: chosen.shell })}
            </p>
        </div>
    );
}
