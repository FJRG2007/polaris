import { useWords } from "./words";
import type { WordKey } from "@/lib/words";
import { useEffect, useState } from "react";
import { CheckMark, CopyMark } from "./marks";
import { installLine, type TroubleReason, type UpdaterTrouble } from "@/lib/self-update";

/** Each reason the updater gives, as the sentence that explains it. */
const TROUBLE_WORDS: Record<TroubleReason, WordKey> = {
    unreachable: "popup.updater.reason.unreachable",
    "no-release": "popup.updater.reason.noRelease",
    "no-package": "popup.updater.reason.noPackage",
    digest: "popup.updater.reason.digest",
    "bad-package": "popup.updater.reason.badPackage",
    install: "popup.updater.reason.install",
    task: "popup.updater.reason.task",
    "missing-tool": "popup.updater.reason.missingTool",
    unknown: "popup.updater.reason.unknown",
    stopped: "popup.updater.reason.stopped"
};

/**
 * Automatic updates that have stopped, said where the version is: why, in the
 * updater's own words below it, and the one thing that repairs them - running
 * the install line again, which replaces the task or job and its updater. The
 * update by hand is offered beside it by the version line while a newer
 * version is out (the notice turns `manual`).
 */
export function UpdaterBroken({ trouble }: { trouble: UpdaterTrouble }): React.JSX.Element {
    const t = useWords();
    const [line, setLine] = useState(() => installLine(null));
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        void browser.runtime
            .getPlatformInfo()
            .then((info) => setLine(installLine(info.os)))
            .catch(() => undefined);
    }, []);
    return (
        <div className="notice small version-steps" role="status">
            <p>
                {t("popup.updater.broken", {
                    reason: t(TROUBLE_WORDS[trouble.reason], {
                        when: new Date(trouble.at).toLocaleString()
                    })
                })}
            </p>
            {trouble.detail ? <p className="muted">{trouble.detail}</p> : null}
            <p className="muted">{t("popup.updater.repair")}</p>
            <button
                type="button"
                className="field"
                title={t("popup.updater.copy")}
                aria-label={t("popup.updater.copy")}
                onClick={() =>
                    void navigator.clipboard.writeText(line).then(
                        () => setCopied(true),
                        () => setCopied(false)
                    )
                }
            >
                <span className="code">{line}</span>
                {copied ? <CheckMark /> : <CopyMark />}
            </button>
        </div>
    );
}
