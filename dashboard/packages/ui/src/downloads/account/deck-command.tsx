"use client";

/**
 * Installing Polaris for Stream Deck in one line, and keeping it current with
 * the same one.
 *
 * Drawn by the extension's own `InstallLine`, for the two systems Elgato's app
 * runs on. Offered above the file and the steps rather than instead of them:
 * the file is for somebody who would rather open it themselves, and it never
 * updates itself.
 */

import { useEffect, useState } from "react";
import { InstallLine } from "./install-line";
import { detectPlatform } from "./install-platform";
import { useTranslations } from "../../i18n";
import {
    DECK_LINE_PLATFORMS,
    deckInstallCommand,
    deckLinePlatform,
    type DeckLinePlatform
} from "./deck-install-command";

export function DeckCommand({ repo }: { repo: string }) {
    const t = useTranslations("account");
    // Detected in an effect: this renders on the server too, where there is no
    // navigator, and the first paint has to match what the server sent.
    const [platform, setPlatform] = useState<DeckLinePlatform>("windows");

    useEffect(() => {
        setPlatform(deckLinePlatform(detectPlatform(navigator.userAgent)));
    }, []);

    const chosen = deckInstallCommand(platform, repo);

    return (
        <InstallLine
            title={t("downloads.streamdeck.command.title")}
            systemLabel={t("downloads.command.system")}
            platform={platform}
            platforms={DECK_LINE_PLATFORMS}
            onPlatformChange={(next) => setPlatform(deckLinePlatform(next))}
            command={chosen.command}
            hint={t("downloads.streamdeck.command.hint", { shell: chosen.shell })}
        />
    );
}
