"use client";

/**
 * Installing Polaris on a deck, step by step, for the app the deck runs on.
 *
 * Built like the extension's steps: the likely choice is preselected from the
 * reader's system but stays a picker, and each choice names its controls the
 * way that app names them. Only what works today is offered - the Elgato
 * Marketplace joins the list once the plugin is actually published there.
 *
 * The download buttons wait on GitHub, so they arrive as nodes the page wraps
 * in their own boundaries; the picker and the steps draw at once.
 */

import { Select } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { detectPlatform } from "@/lib/install-platform";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** Where the deck is driven from. */
export type DeckHost = "streamdeck" | "opendeck" | "companion";

/** Every choice, in the order the picker offers them. */
export const DECK_HOSTS: readonly DeckHost[] = ["streamdeck", "opendeck", "companion"];

/** Each app's name, which is the same in every language. */
const HOST_LABELS: Readonly<Record<DeckHost, string>> = {
    // i18n-ignore a product's name
    streamdeck: "Stream Deck app",
    // i18n-ignore a product's name
    opendeck: "OpenDeck",
    // i18n-ignore a product's name
    companion: "Bitfocus Companion"
};

/** Where Node.js is downloaded from, for OpenDeck. */
const NODE_DOWNLOAD = "https://nodejs.org/en/download";

/**
 * Which app to put first. Elgato's app has no Linux build, so Linux is offered
 * OpenDeck; everyone else the app that came with the deck. Companion is a
 * choice people make on purpose and is never guessed.
 */
export function detectDeckHost(userAgent: string): DeckHost {
    return detectPlatform(userAgent) === "linux" ? "opendeck" : "streamdeck";
}

/** Something to press, named the way the app names it. */
function Press({ text }: { text: string }) {
    return <b className="font-medium text-foreground">{text}</b>;
}

export function DeckInstallSteps({
    pluginFile,
    moduleFile,
    address
}: {
    /** The `.streamDeckPlugin` button, for the Stream Deck app and OpenDeck. */
    pluginFile: React.ReactNode;
    /** The Companion module's `.tgz` button. */
    moduleFile: React.ReactNode;
    /** This Polaris's address, which Companion's connection asks for. */
    address: string;
}) {
    const t = useTranslations("account");
    const [host, setHost] = useState<DeckHost>("streamdeck");
    // A choice the reader made outranks the one that was detected.
    const picked = useRef(false);

    // Detected in an effect: this renders on the server too, where there is no
    // navigator, and the first paint has to match what the server sent.
    useEffect(() => {
        if (!picked.current) setHost(detectDeckHost(navigator.userAgent));
    }, []);

    const press = (chunks: React.ReactNode[]) => {
        const text = chunks.join("");
        return <Press key={text} text={text} />;
    };

    return (
        <div className="flex flex-col gap-3">
            <label className="flex max-w-sm flex-col gap-1 text-xs text-muted-foreground">
                {t("downloads.streamdeck.install.where")}
                <Select
                    value={host}
                    aria-label={t("downloads.streamdeck.install.where")}
                    onValueChange={(value) => {
                        picked.current = true;
                        setHost(value as DeckHost);
                    }}
                    options={DECK_HOSTS.map((entry) => ({ value: entry, label: HOST_LABELS[entry] }))}
                />
            </label>

            {host === "streamdeck" ? (
                <ol className="ml-5 flex list-decimal flex-col gap-4 text-sm leading-relaxed marker:text-muted-foreground">
                    <li className="flex flex-col gap-2">
                        {t("downloads.streamdeck.install.downloadPlugin")}
                        {pluginFile}
                    </li>
                    <li>{t("downloads.streamdeck.install.openFile")}</li>
                    <li>{t.rich("downloads.streamdeck.install.connectKey", { press })}</li>
                </ol>
            ) : null}

            {host === "opendeck" ? (
                <ol className="ml-5 flex list-decimal flex-col gap-4 text-sm leading-relaxed marker:text-muted-foreground">
                    <li>
                        {t.rich("downloads.streamdeck.install.node", {
                            link: (chunks) => (
                                <a
                                    key="link"
                                    className="underline"
                                    href={NODE_DOWNLOAD}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {chunks}
                                </a>
                            )
                        })}
                    </li>
                    <li className="flex flex-col gap-2">
                        {t("downloads.streamdeck.install.downloadPlugin")}
                        {pluginFile}
                    </li>
                    <li>{t.rich("downloads.streamdeck.install.fromFile", { press })}</li>
                    <li>{t.rich("downloads.streamdeck.install.connectKey", { press })}</li>
                </ol>
            ) : null}

            {host === "companion" ? (
                <ol className="ml-5 flex list-decimal flex-col gap-4 text-sm leading-relaxed marker:text-muted-foreground">
                    <li className="flex flex-col gap-2">
                        {t("downloads.streamdeck.install.downloadModule")}
                        {moduleFile}
                    </li>
                    <li>{t.rich("downloads.streamdeck.install.importModule", { press })}</li>
                    <li>
                        {t.rich("downloads.streamdeck.install.addConnection", { press })}
                        <span className="mt-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                            <code className="min-w-0 flex-1 truncate text-foreground" title={address}>
                                {address}
                            </code>
                            <CopyButton value={address} />
                        </span>
                    </li>
                    <li>{t("downloads.streamdeck.install.approveCode")}</li>
                </ol>
            ) : null}
        </div>
    );
}
