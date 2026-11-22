// One stylesheet, which pulls in the design tokens itself: see globals.css for why
// the token import cannot live here.
import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { CSSProperties, ReactNode } from "react";
import { FONT_CLASSES } from "./fonts";
import { IdleWatch } from "@/components/idle-watch";
import { DropGuard } from "@/components/drop-guard";
import { ContextMenuFallback } from "@/components/context-menu-fallback";
import { PhoneRegionProvider } from "@polaris/ui";
import { localeDirection, themeClass } from "@polaris/core";
import { requestCountry } from "@/lib/request-context";
import { resolveSession } from "@/lib/session";
import { CHUNK_RECOVERY_SCRIPT } from "@/lib/stale-build";
import { INPUT_MODALITY_SCRIPT } from "@/lib/input-modality";
import { getClient, getLocale, getTranslations } from "@/lib/i18n/request";
import { pickMessages } from "@/lib/i18n/translate";
import { seasonPreviewFor } from "@/lib/seasonal-preview";
import { serverSeason } from "@/lib/seasonal-service";
import { seasonIconPng, seasonIconSvg } from "@/lib/season-icon";
import { I18nProvider, LocaleSync } from "@/components/i18n/i18n-provider";
import { ConnectionBanner } from "@/components/connection-banner";
import { resolveTextSize, resolveTheme } from "@/lib/display-prefs-service";
import { defaultPreviewMetadata } from "@/lib/link-preview/metadata";

/**
 * The page is laid out to the very edges of the screen, under a notch, a
 * punch-hole or a Dynamic Island and beside one when the phone is turned, so
 * the browser reports those edges as `env(safe-area-inset-*)` instead of
 * leaving black bars around the page. The chrome keeps its contents clear of
 * them - see `--safe-top` and its siblings in the UI package's tokens.css,
 * which is the one place that model is written down.
 */
export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover"
};

/** The document's title and description, the description in the reader's
 *  language, the rule that keeps every page out of search engines, and the
 *  branded picture a pasted link is previewed with (a public link page swaps in
 *  its own - see `lib/link-preview`). The title is the product's name, which is
 *  not translated. */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("common");
    // The icon the tab shows before any script, and the one a phone puts on
    // its home screen, in the season's dress; its address names the season,
    // so a browser holding last season's icon fetches the new one.
    const season = await serverSeason().catch(() => null);
    return {
        title: "Polaris", // i18n-ignore
        description: t("meta.description"),
        icons: {
            icon: [{ url: seasonIconSvg(season), type: "image/svg+xml", sizes: "any" }],
            apple: [{ url: seasonIconPng(season, 180), sizes: "180x180", type: "image/png" }]
        },
        ...(await defaultPreviewMetadata(t("meta.description"))),
        // Every page, public or not, stays out of search engines and their
        // caches; next.config's X-Robots-Tag says the same on every response.
        robots: {
            index: false,
            follow: false,
            nocache: true,
            googleBot: { index: false, follow: false, noimageindex: true }
        }
    };
}

/**
 * The theme, the text size and the language are resolved here, on the server,
 * and written onto the document it is served as.
 *
 * Which means there is no flash: the first paint is already in the right palette
 * and at the right size, with no script to run and nothing to correct
 * afterwards. It costs one cached settings read per request - and it answers
 * "dark" at 16px for anything with no session and no database, which is what
 * keeps a build that prerenders a page from needing one.
 *
 * The language is the reader's (see `getLocale`), and the `common` and
 * `components` namespaces are handed to every client component from here -
 * `components` because the shared components are drawn on every screen, signed
 * in or not; a screen that needs more asks for it with `<Messages>`.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
    const session = await resolveSession().catch(() => null);
    const [theme, textSize, locale, client, seasonPreview, country] = await Promise.all([
        resolveTheme(session?.id ?? null),
        resolveTextSize(session?.id ?? null),
        getLocale(),
        getClient(),
        // An admin trying a season on paints in it from the first frame; the
        // frame keeps it from there (see `lib/seasonal-preview`).
        session?.isAdmin ? seasonPreviewFor(session.sessionId).catch(() => null) : null,
        // Where the reader is, for a phone field to start on their country.
        requestCountry().catch(() => null)
    ]);

    return (
        <html
            lang={locale}
            dir={localeDirection(locale)}
            className={`${FONT_CLASSES} ${themeClass(theme)}`.trim()}
            // Everything Polaris draws is sized in rem, so this is what the whole
            // interface is laid out against - see globals.css.
            style={{ "--app-text-size": `${textSize}px` } as CSSProperties}
            data-season={seasonPreview ?? undefined}
            suppressHydrationWarning
        >
            <head>
                {/* First in the document, so it is listening before any chunk can
                    fail - see recoverMissingChunks. */}
                <script dangerouslySetInnerHTML={{ __html: CHUNK_RECOVERY_SCRIPT }} />
                {/* A tap from a key, so a focus ring follows only the keyboard - see input-modality.ts. */}
                <script dangerouslySetInnerHTML={{ __html: INPUT_MODALITY_SCRIPT }} />
            </head>
            <body>
                {/* What the desktop app's window is dragged by on a page with no
                    header; zero-sized in a browser - see tokens.css. */}
                <div aria-hidden className="app-drag-strip" />
                <I18nProvider
                    locale={locale}
                    client={client}
                    messages={pickMessages(locale, ["common", "components"])}
                >
                    <LocaleSync locale={locale} signedIn={session !== null} />
                    <DropGuard />
                    <ContextMenuFallback />
                    <IdleWatch />
                    <ConnectionBanner />
                    <PhoneRegionProvider country={country}>{children}</PhoneRegionProvider>
                </I18nProvider>
            </body>
        </html>
    );
}
