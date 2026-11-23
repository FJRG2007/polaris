import { useWords } from "./words";
import type { WordKey } from "@/lib/words";
import type { ReactNode } from "react";
import type { TroubleReason, UpdaterTrouble } from "@/lib/self-update";

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
 * Automatic updates that have stopped, said where the version is: why, and the
 * updater's own words below it. Nothing here asks for a command: while a newer
 * version is out the caller hands in the update by hand (download and steps) as
 * `children`, since the notice turns `manual` once the updater says it is not
 * working.
 */
export function UpdaterBroken({
    trouble,
    children
}: {
    trouble: UpdaterTrouble;
    children?: ReactNode;
}): React.JSX.Element {
    const t = useWords();
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
            {children}
        </div>
    );
}
