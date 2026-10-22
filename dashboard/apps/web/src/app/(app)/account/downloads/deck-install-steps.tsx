"use client";

/**
 * Installing Polaris on a deck, step by step, for the app the deck runs on.
 *
 * Built like the extension's steps: the likely choice is preselected from the
 * reader's system but stays a picker, and each choice names its controls the
 * way that app names them. The Stream Deck app's steps are written for
 * somebody who has never opened it: where the actions list is, where a key's
 * settings open, and what to press there, in the words the plugin and Elgato's
 * own guide use. The one-line install sits above them, for the two systems the
 * app runs on.
 *
 * The download buttons wait on GitHub, so they arrive as nodes the page wraps
 * in their own boundaries; the picker and the steps draw at once.
 */

import { cn, Select } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { DeckCommand } from "./deck-command";
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

/**
 * Each app's own mark, the way the extension's picker shows each browser's.
 * Elgato's is Simple Icons' single-colour glyph, drawn in the text colour so it
 * reads on both themes; OpenDeck and Companion publish only their app icons,
 * taken from their repositories (nekename/OpenDeck, bitfocus/companion).
 */
export function DeckHostMark({ host, className }: { host: DeckHost; className?: string }) {
    const size = cn("size-4 shrink-0", className);
    if (host === "streamdeck")
        return (
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className={size}>
                <path fill="currentColor" d="m13.8818 8.3964.0261.0196 9.9494 5.7172c-.4884 2.729-1.9196 5.2223-4.0384 7.0253A11.9262 11.9262 0 0 1 12.097 24c-3.1925 0-6.1939-1.2477-8.4527-3.5144C1.3868 18.2188.1427 15.2044.1427 12c0-3.2042 1.244-6.2187 3.5015-8.4854C5.9019 1.248 8.9032 0 12.097 0c2.4394 0 4.7847.7333 6.783 2.1187 1.9526 1.354 3.4466 3.2357 4.3227 5.4422.1112.2829.2149.5736.3051.8657l-2.1255 1.2359a9.4924 9.4924 0 0 0-.2619-.8694c-1.354-3.8303-4.9813-6.4048-9.0237-6.4048C6.8171 2.3883 2.522 6.7005 2.522 12c0 5.2995 4.295 9.6115 9.5748 9.6115 2.052 0 4.0084-.6442 5.6596-1.8647 1.6172-1.1955 2.8036-2.8337 3.4309-4.7364l.0065-.0419L9.5906 8.3048v7.2256l4.0004-2.3138 2.06 1.1811-5.9962 3.4688-2.12-1.2126V7.1943l2.1174-1.2245 4.2309 2.4279-.0013-.0013" />
            </svg>
        );
    const src = host === "opendeck" ? "/logos/opendeck.webp" : "/logos/bitfocus-companion.webp";
    return <img src={src} alt="" aria-hidden="true" className={size} />;
}

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

/** This Polaris's address, to copy into a settings field. */
function AddressBox({ address }: { address: string }) {
    return (
        <span className="mt-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
            <code className="min-w-0 flex-1 truncate text-foreground" title={address}>
                {address}
            </code>
            <CopyButton value={address} />
        </span>
    );
}

export function DeckInstallSteps({
    pluginFile,
    moduleFile,
    address,
    repo
}: {
    /** The `.streamDeckPlugin` button, for the Stream Deck app and OpenDeck. */
    pluginFile: React.ReactNode;
    /** The Companion module's `.tgz` button. */
    moduleFile: React.ReactNode;
    /** This Polaris's address, which Companion's connection asks for, or null to use the one the page is on. */
    address: string | null;
    /** The repository the plugin's releases and install scripts come from. */
    repo: string;
}) {
    const t = useTranslations("account");
    const [host, setHost] = useState<DeckHost>("streamdeck");
    const [origin, setOrigin] = useState(address ?? "");
    // A choice the reader made outranks the one that was detected.
    const picked = useRef(false);

    // Detected in an effect: this renders on the server too, where there is no
    // navigator, and the first paint has to match what the server sent.
    useEffect(() => {
        if (!picked.current) setHost(detectDeckHost(navigator.userAgent));
    }, []);

    useEffect(() => {
        if (!address) setOrigin(window.location.origin);
    }, [address]);

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
                    options={DECK_HOSTS.map((entry) => ({
                        value: entry,
                        label: HOST_LABELS[entry],
                        icon: <DeckHostMark host={entry} />
                    }))}
                />
            </label>

            {host === "streamdeck" ? (
                <>
                    <DeckCommand repo={repo} />
                    <ol className="ml-5 flex list-decimal flex-col gap-4 text-sm leading-relaxed marker:text-muted-foreground">
                        <li className="flex flex-col gap-2">
                            {t("downloads.streamdeck.install.orFile")}
                            {pluginFile}
                        </li>
                        <li>{t.rich("downloads.streamdeck.install.openApp", { press })}</li>
                        <li>{t.rich("downloads.streamdeck.install.dragAction", { press })}</li>
                        <li>
                            {t.rich("downloads.streamdeck.install.keySettings", { press })}
                            <AddressBox address={origin} />
                        </li>
                        <li>{t("downloads.streamdeck.install.approveKey")}</li>
                        <li>{t.rich("downloads.streamdeck.install.pickAction", { press })}</li>
                    </ol>
                </>
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
                        <AddressBox address={origin} />
                    </li>
                    <li>{t("downloads.streamdeck.install.approveCode")}</li>
                    <li>{t.rich("downloads.streamdeck.install.lockCompanion", { press })}</li>
                </ol>
            ) : null}
        </div>
    );
}
