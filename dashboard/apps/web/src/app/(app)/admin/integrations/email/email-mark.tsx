/**
 * How an email sender is drawn on its card: an envelope in one tint, and the
 * tone of the status badge beside its name.
 */

import type { SVGProps } from "react";
import { mark } from "@/components/brand-icons";

/** Email is a protocol, not a brand, so this is a plain envelope rather than any
 *  one provider's mark - the provider is named on the card beside it. */
export function EmailLogo(props: SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" role="img" aria-hidden {...mark(props)}>
            <path
                fill="currentColor"
                d="M1.5 4.5h21A1.5 1.5 0 0 1 24 6v12a1.5 1.5 0 0 1-1.5 1.5h-21A1.5 1.5 0 0 1 0 18V6a1.5 1.5 0 0 1 1.5-1.5Zm.9 2.4v.63l9.6 6.24 9.6-6.24V6.9H2.4Zm19.2 3.09-8.94 5.81a1.5 1.5 0 0 1-1.62 0L2.4 9.99v7.11h19.2V9.99Z"
            />
        </svg>
    );
}

export const EMAIL_CHANNEL_MARK = { Logo: EmailLogo, color: "#8B5CF6" };

export const CHANNEL_STATUS_TONE: Record<string, string> = {
    connected: "border-success-edge text-success",
    connecting: "border-warning-edge text-warning",
    qr: "border-warning-edge text-warning",
    error: "border-danger-edge text-danger", // i18n-ignore
    disconnected: "border-danger-edge text-danger"
};
