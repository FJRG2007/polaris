/**
 * The question the worker asks before Polar uses a site in this browser for
 * the first time: once, always, or not at all. A window of its own because
 * Polar asks while the popup is closed, and because the answer has to come
 * from a click - Firefox grants a site to the extension only inside one.
 */

import "../popup/style.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { askBackground } from "@/lib/messages";
import { WordsProvider, useWords } from "../popup/words";
import { ACCOUNT_LOCALE, currentLocale } from "@/lib/locale-store";

type Grant = "once" | "always" | "deny";

function Ask({
    id,
    site,
    hint
}: {
    id: string;
    site: string;
    /** The answer the person already gave in Polar's chat card, which this
     *  window opens on. It still has to be clicked here. */
    hint: "once" | "always" | null;
}): React.JSX.Element {
    const t = useWords();
    const [busy, setBusy] = useState(false);

    const decide = async (grant: Grant) => {
        setBusy(true);
        if (grant !== "deny" && browser.permissions?.request) {
            // Chromium already holds every page; Firefox asks here, in the click.
            const origins = [`https://${site}/*`, `http://${site}/*`];
            const granted = browser.permissions.request({ origins }).catch(() => false);
            if (!(await granted)) grant = "deny";
        }
        await askBackground({ kind: "polarBrowserGrant", id, grant }).catch(() => undefined);
        window.close();
    };

    return (
        <main className="stack" style={{ padding: 16, gap: 12 }}>
            <h1 className="strong" style={{ fontSize: 15, margin: 0, overflowWrap: "anywhere" }}>
                {t("polar.browserAsk", { site })}
            </h1>
            <p className="muted small" style={{ margin: 0 }}>
                {t("polar.browserAskBody")}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button
                    className={hint === "always" ? undefined : "primary"}
                    disabled={busy}
                    autoFocus={hint !== "always"}
                    onClick={() => void decide("once")}
                >
                    {t("polar.browserOnce")}
                </button>
                <button
                    className={hint === "always" ? "primary" : undefined}
                    disabled={busy}
                    autoFocus={hint === "always"}
                    onClick={() => void decide("always")}
                >
                    {t("polar.browserAlways")}
                </button>
                <button disabled={busy} onClick={() => void decide("deny")}>
                    {t("polar.browserDeny")}
                </button>
            </div>
        </main>
    );
}

const root = document.getElementById("root");
const query = new URLSearchParams(location.search);
const id = query.get("id") ?? "";
const site = query.get("site") ?? "";
const asked = query.get("hint");
const hint = asked === "once" || asked === "always" ? asked : null;
if (root && id && site) {
    void currentLocale().then((locale) =>
        createRoot(root).render(
            <WordsProvider initial={locale} follow={(onChange) => ACCOUNT_LOCALE.watch(onChange)}>
                <Ask id={id} site={site} hint={hint} />
            </WordsProvider>
        )
    );
}
