"use client";

/**
 * The shared picture viewer (`@polaris/ui/image-viewer`), with what only the
 * dashboard has: its words, and the menu that copies, saves, forwards and
 * reports, which needs the address Polaris hands out and the conversation.
 * The public site renders the same viewer with its own words and no menu.
 */

import { useAppUrl } from "@/components/app-url";
import { imageItems } from "@/components/image-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    ImageViewer as SharedViewer,
    closesOnRelease,
    thumbnailOf,
    type ImageOrigin,
    type ViewedImage,
    type ViewerLabels
} from "@polaris/ui/image-viewer";

export { closesOnRelease, thumbnailOf, type ImageOrigin, type ViewedImage };

export function ImageViewer({
    onForward,
    onReport,
    ...props
}: {
    image: ViewedImage | null;
    onClose: () => void;
    origin?: ImageOrigin;
    gallery?: readonly ViewedImage[];
    onNavigate?: (image: ViewedImage) => void;
    /** Send it on. The conversation picker is the caller's - it already has one
     *  for forwarding a message, and a picture is a message. */
    onForward?: (messageId: string) => void;
    onReport?: (messageId: string) => void;
}) {
    const t = useTranslations("components");
    const baseUrl = useAppUrl();
    const labels: ViewerLabels = {
        zoomIn: t("viewer.zoomIn"),
        zoomOut: t("viewer.zoomOut"),
        more: t("viewer.more"),
        close: t("viewer.close"),
        previous: t("viewer.previous"),
        next: t("viewer.next"),
        position: (index, count) => t("viewer.position", { index, count })
    };
    return (
        <SharedViewer
            {...props}
            labels={labels}
            menu={({ image, announce, Item, Separator }) =>
                imageItems({ image, baseUrl, announce, onForward, onReport, Item, Separator })
            }
        />
    );
}
