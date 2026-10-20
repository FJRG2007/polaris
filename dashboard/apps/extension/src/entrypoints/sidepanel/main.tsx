import "./panel.css";
import "../popup/style.css";
import { Panel } from "./panel";
import { createRoot } from "react-dom/client";
import { WordsProvider } from "../popup/words";
import { ACCOUNT_LOCALE, currentLocale } from "@/lib/locale-store";

// The same language and colours as the popup: the panel is the popup's frame
// around Polaris's own Polar.
const root = document.getElementById("root");
if (root) {
    void currentLocale().then((locale) =>
        createRoot(root).render(
            <WordsProvider initial={locale} follow={(onChange) => ACCOUNT_LOCALE.watch(onChange)}>
                <Panel />
            </WordsProvider>
        )
    );
}
