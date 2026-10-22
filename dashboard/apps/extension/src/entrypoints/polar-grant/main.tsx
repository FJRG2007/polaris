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

function Ask({ id, site }: { id: string; site: string }): React.JSX.Element {
    const t = useWords();
    const [busy, setBusy] = useState(false);

    const decide = async (grant: Grant) => {
        setBusy(true);
        if (grant !== "deny" && browser.permissions?.request) {
            // Chromium already holds every page; Firefox asks here, in the click.
            const origins = [`https://${site}/*`, `http://${site}/*`];
            const held = await browser.permissions.contains({ origins }).catch(() => false);
            if (!held && !(await browser.permissions.request({ origins }).catch(() => false))) {
                grant = "deny";
            }
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
                <button className="primary" disabled={busy} onClick={() => void decide("once")}>
                    {t("polar.browserOnce")}
                </button>
                <button disabled={busy} onClick={() => void decide("always")}>
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
if (root && id && site) {
    void currentLocale().then((locale) =>
        createRoot(root).render(
            <WordsProvider initial={locale} follow={(onChange) => ACCOUNT_LOCALE.watch(onChange)}>
                <Ask id={id} site={site} />
            </WordsProvider>
        )
    );
}
