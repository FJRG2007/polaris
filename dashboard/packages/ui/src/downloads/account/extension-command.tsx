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

import { InstallLine } from "./install-line";
import { installCommand } from "./install-command";
import { useTranslations } from "../../i18n";
import { platformShell } from "./install-platform";
import { useInstallPlatform } from "./platform-select";

export function ExtensionCommand({ repo }: { repo: string }) {
    const t = useTranslations("account");
    const [platform, setPlatform] = useInstallPlatform();

    const chosen = installCommand(platformShell(platform), repo);

    return (
        <InstallLine
            title={t("downloads.command.title")}
            systemLabel={t("downloads.command.system")}
            platform={platform}
            onPlatformChange={setPlatform}
            command={chosen.command}
            hint={t("downloads.command.hint", { shell: chosen.shell })}
        />
    );
}
