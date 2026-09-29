import "./style.css";
import { App } from "./app";
import { WordsProvider } from "./words";
import { createRoot } from "react-dom/client";
import { ACCOUNT_LOCALE, currentLocale } from "@/lib/locale-store";

// The language first, so the popup opens in it rather than switching under
// somebody's eyes: a storage read, a few milliseconds.
const root = document.getElementById("root");
if (root) {
    void currentLocale().then((locale) =>
        createRoot(root).render(
            <WordsProvider initial={locale} follow={(onChange) => ACCOUNT_LOCALE.watch(onChange)}>
                <App />
            </WordsProvider>
        )
    );
}
