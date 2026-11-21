/**
 * The Open Graph and Twitter tags a pasted Polaris link is previewed from.
 *
 * Every page carries the plain branded banner (set by the root layout); a public
 * link page replaces it with the preview for its kind. The image address is
 * absolute and built on the same base the link itself was handed out on - a
 * crawler has nothing else to resolve a relative one against, and the request's
 * own Host is the caller's to write.
 */

import type { Metadata } from "next";

import { loadEnv } from "@polaris/config";
import type { PreviewKind } from "./policy";
import { getTranslations } from "@/lib/i18n/request";
import { appBaseUrl, sharingBaseUrl } from "@/lib/domain-service";
import { resolveLinkPreview, type ResolvedPreview } from "./resolve";

/** The picture's size, as `image.tsx` draws it. */
const PREVIEW_SIZE = { width: 1200, height: 630 } as const;

/** Kinds whose links are minted on the sharing domain rather than the app's. */
const SHARING_KINDS: ReadonlySet<PreviewKind> = new Set([
    "share",
    "transfer",
    "snippet",
    "fileRequest",
    "textRequest",
    "note",
    "task",
    "document",
    "chat",
    "analytics",
    "send"
]);

/** The origin to put in front of an image path. Never throws: a page is always drawn. */
async function previewBase(kind: PreviewKind | null): Promise<string | null> {
    try {
        const base = kind && SHARING_KINDS.has(kind) ? await sharingBaseUrl() : await appBaseUrl();
        return base.replace(/\/+$/, "");
    } catch {
        try {
            return loadEnv().POLARIS_APP_URL.replace(/\/+$/, "");
        } catch {
            return null;
        }
    }
}

/** The words a preview is drawn and described with, in the instance's language. */
export async function previewWords(preview: ResolvedPreview) {
    const t = await getTranslations("common");
    if (!preview.kind) return { title: "Polaris", description: t("meta.description") }; // i18n-ignore
    const label = t(`linkPreview.kinds.${preview.kind}`);
    const title = preview.fileCount
        ? t("linkPreview.files", { count: preview.fileCount })
        : preview.title;
    return {
        label,
        title,
        detail: preview.detail,
        description: title
            ? [label, preview.detail].filter(Boolean).join(" - ")
            : t(`linkPreview.descriptions.${preview.kind}`)
    };
}

function tags(title: string, description: string, image: string | null): Metadata {
    const images = image ? [{ url: image, ...PREVIEW_SIZE, alt: title }] : undefined;
    return {
        openGraph: {
            type: "website",
            siteName: "Polaris", // i18n-ignore
            title,
            description,
            ...(images ? { images } : {})
        },
        twitter: {
            card: "summary_large_image",
            title,
            description,
            ...(image ? { images: [image] } : {})
        }
    };
}

/** The plain branded preview every page carries unless it says otherwise. */
export async function defaultPreviewMetadata(description: string): Promise<Metadata> {
    const base = await previewBase(null);
    return tags("Polaris", description, base ? `${base}/api/og/default` : null); // i18n-ignore
}

/** The preview for one public link: its kind, and its name only when that is safe. */
export async function linkPreviewMetadata(kind: PreviewKind, token: string): Promise<Metadata> {
    const [preview, base] = await Promise.all([resolveLinkPreview(kind, token), previewBase(kind)]);
    const words = await previewWords(preview);
    const title = words.title ?? words.label ?? "Polaris"; // i18n-ignore
    const image = base ? `${base}/api/og/${kind}/${encodeURIComponent(token || "-")}` : null;
    return tags(title, words.description, image);
}
