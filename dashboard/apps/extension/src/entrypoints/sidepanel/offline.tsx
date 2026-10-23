/**
 * Polar while Polaris does not answer: the last copy of the chats, read-only,
 * drawn by the extension itself; a line saying since when, a button to try
 * again and a try of its own on a growing delay that hands back to the live
 * chat the moment Polaris answers; and a draft that is kept, never sent.
 *
 * Takes the copy, the draft and the probe as props - the panel reads and
 * writes browser storage - so it can be drawn and driven in a test.
 */

import { useWords } from "../popup/words";
import * as offline from "@/lib/polar-offline";
import { useEffect, useRef, useState } from "react";

export interface OfflineProps {
    readonly kept: offline.Kept | null;
    /** When Polaris was first found not answering, ms. */
    readonly since: number;
    readonly draft: string;
    readonly onDraft: (text: string) => void;
    /** Asks Polaris once; true when it answered. */
    readonly probe: () => Promise<boolean>;
    /** Polaris answered: back to the live chat. */
    readonly onBack: () => void;
}

function Message({ message }: { message: offline.KeptMessage }): React.JSX.Element {
    const t = useWords();
    return (
        <li className={`kept-message ${message.role}`}>
            <span className="kept-who">
                {message.role === "user" ? t("polar.offlineYou") : t("polar.title")}
            </span>
            {offline.blocksOf(message.text).map((block, at) =>
                block.kind === "code" ? (
                    <pre key={at}>
                        <code>{block.text}</code>
                    </pre>
                ) : (
                    <p key={at}>{block.text}</p>
                )
            )}
        </li>
    );
}

export function OfflineView({
    kept,
    since,
    draft,
    onDraft,
    probe,
    onBack
}: OfflineProps): React.JSX.Element {
    const t = useWords();
    const conversations = kept?.conversations ?? [];
    const [open, setOpen] = useState<string | null>(conversations[0]?.id ?? null);
    const [checking, setChecking] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [left, setLeft] = useState(() => Math.round(offline.retryDelay(0) / 1000));
    const probing = useRef(false);
    // Read at the moment of trying, so a timer set earlier asks with the newest.
    const latest = useRef({ probe, onBack });
    latest.current = { probe, onBack };

    const tryNow = async (): Promise<void> => {
        if (probing.current) return;
        probing.current = true;
        setChecking(true);
        const answered = await latest.current.probe().catch(() => false);
        probing.current = false;
        setChecking(false);
        if (answered) return latest.current.onBack();
        setAttempt((n) => n + 1);
    };

    // The try of its own: counts down, asks, and waits longer each time.
    useEffect(() => {
        let remaining = Math.round(offline.retryDelay(attempt) / 1000);
        setLeft(remaining);
        const timer = setInterval(() => {
            remaining -= 1;
            setLeft(remaining);
            if (remaining <= 0) {
                clearInterval(timer);
                void tryNow();
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [attempt]);

    const shown = conversations.find((one) => one.id === open) ?? conversations[0];
    const time = new Date(since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    return (
        <div className="side-app">
            <div className="side-bar offline-strip" role="status">
                <span className="grow" title={t("polar.offline")}>
                    {t("polar.offlineSince", { time })}
                </span>
                <span className="offline-next">
                    {checking
                        ? t("polar.offlineChecking")
                        : t("polar.offlineRetrying", { seconds: String(Math.max(0, left)) })}
                </span>
                <button onClick={() => void tryNow()} disabled={checking}>
                    {t("polar.retry")}
                </button>
            </div>
            <div className="kept">
                {shown ? (
                    <>
                        <p className="kept-note">{t("polar.offlineKept")}</p>
                        {conversations.length > 1 ? (
                            <nav className="kept-chats" aria-label={t("polar.offlineChats")}>
                                {conversations.map((one) => (
                                    <button
                                        key={one.id}
                                        className={one.id === shown.id ? "" : "ghost"}
                                        aria-current={one.id === shown.id ? "true" : undefined}
                                        title={one.title}
                                        onClick={() => setOpen(one.id)}
                                    >
                                        {one.title}
                                    </button>
                                ))}
                            </nav>
                        ) : null}
                        <ol className="kept-messages">
                            {shown.messages.map((message, at) => (
                                <Message key={at} message={message} />
                            ))}
                        </ol>
                    </>
                ) : (
                    <p className="kept-note">{t("polar.offlineNone")}</p>
                )}
            </div>
            <label className="kept-draft">
                <span>{t("polar.offlineDraft")}</span>
                <textarea
                    rows={3}
                    value={draft}
                    maxLength={2000}
                    onChange={(event) => onDraft(event.target.value)}
                />
            </label>
        </div>
    );
}

/** The draft written while Polaris was down, offered once it is back. */
export function DraftOffer({
    onUse,
    onDiscard
}: {
    onUse: () => void;
    onDiscard: () => void;
}): React.JSX.Element {
    const t = useWords();
    return (
        <div className="side-bar" role="status">
            <span className="grow" title={t("polar.draftBack")}>
                {t("polar.draftBack")}
            </span>
            <button onClick={onUse}>{t("polar.draftUse")}</button>
            <button className="ghost" onClick={onDiscard}>
                {t("polar.draftDiscard")}
            </button>
        </div>
    );
}
