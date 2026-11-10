/**
 * Brand marks for the connector catalog, monochrome in `currentColor` like
 * every mark beside them. The path data is each brand's mark as Simple Icons
 * 13.21.0 publishes it (simpleicons.org, sourced from the vendors' own brand
 * guidelines) - copied, never drawn. A vendor with no mark in that registry
 * (Booking.com) is shown as its monogram instead.
 */

import { cn } from "@polaris/ui";
import { providerInitials } from "@/components/logos";
import { initialsInk, tintFor } from "@polaris/core";
import * as brand from "@/components/brand-icons";
import type { ComponentType, SVGProps } from "react";

function Mark({ d, ...props }: SVGProps<SVGSVGElement> & { d: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
            fill="currentColor"
            aria-hidden="true"
            {...props}
        >
            <path d={d} />
        </svg>
    );
}

export function StripeMark(props: SVGProps<SVGSVGElement>) {
    return <Mark d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z" {...props} />;
}

export function BinanceMark(props: SVGProps<SVGSVGElement>) {
    return <Mark d="M16.624 13.9202l2.7175 2.7154-7.353 7.353-7.353-7.352 2.7175-2.7164 4.6355 4.6595 4.6356-4.6595zm4.6366-4.6366L24 12l-2.7154 2.7164L18.5682 12l2.6924-2.7164zm-9.272.001l2.7163 2.6914-2.7164 2.7174v-.001L9.2721 12l2.7164-2.7154zm-9.2722-.001L5.4088 12l-2.6914 2.6924L0 12l2.7164-2.7164zM11.9885.0115l7.353 7.329-2.7174 2.7154-4.6356-4.6356-4.6355 4.6595-2.7174-2.7154 7.353-7.353z" {...props} />;
}

export function ShopifyMark(props: SVGProps<SVGSVGElement>) {
    return <Mark d="M15.337 23.979l7.216-1.561s-2.604-17.613-2.625-17.73c-.018-.116-.114-.192-.211-.192s-1.929-.136-1.929-.136-1.275-1.274-1.439-1.411c-.045-.037-.075-.057-.121-.074l-.914 21.104h.023zM11.71 11.305s-.81-.424-1.774-.424c-1.447 0-1.504.906-1.504 1.141 0 1.232 3.24 1.715 3.24 4.629 0 2.295-1.44 3.76-3.406 3.76-2.354 0-3.54-1.465-3.54-1.465l.646-2.086s1.245 1.066 2.28 1.066c.675 0 .975-.545.975-.932 0-1.619-2.654-1.694-2.654-4.359-.034-2.237 1.571-4.416 4.827-4.416 1.257 0 1.875.361 1.875.361l-.945 2.715-.02.01zM11.17.83c.136 0 .271.038.405.135-.984.465-2.064 1.639-2.508 3.992-.656.213-1.293.405-1.889.578C7.697 3.75 8.951.84 11.17.84V.83zm1.235 2.949v.135c-.754.232-1.583.484-2.394.736.466-1.777 1.333-2.645 2.085-2.971.193.501.309 1.176.309 2.1zm.539-2.234c.694.074 1.141.867 1.429 1.755-.349.114-.735.231-1.158.366v-.252c0-.752-.096-1.371-.271-1.871v.002zm2.992 1.289c-.02 0-.06.021-.078.021s-.289.075-.714.21c-.423-1.233-1.176-2.37-2.508-2.37h-.115C12.135.209 11.669 0 11.265 0 8.159 0 6.675 3.877 6.21 5.846c-1.194.365-2.063.636-2.16.674-.675.213-.694.232-.772.87-.075.462-1.83 14.063-1.83 14.063L15.009 24l.927-21.166z" {...props} />;
}

export function AdobeMark(props: SVGProps<SVGSVGElement>) {
    return <Mark d="M13.966 22.624l-1.69-4.281H8.122l3.892-9.144 5.662 13.425zM8.884 1.376H0v21.248zm15.116 0h-8.884L24 22.624Z" {...props} />;
}

export function MarketoMark(props: SVGProps<SVGSVGElement>) {
    return <Mark d="M16.146 0v24l6.134-4.886V3.334zM13.293 18.758l-4.939 2.157V2.086l4.939 1.462zM1.721 18.205l3.78-.999V5.188l-3.762-.606z" {...props} />;
}

export function LinkedInMark(props: SVGProps<SVGSVGElement>) {
    return <Mark d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" {...props} />;
}

const MARKS: Record<string, ComponentType<{ className?: string }>> = {
    stripe: StripeMark,
    binance: BinanceMark,
    shopify: ShopifyMark,
    adobe: AdobeMark,
    marketo: MarketoMark,
    linkedin: LinkedInMark,
    spotify: brand.SpotifyMark,
    cloudflare: brand.CloudflareMark
};

/** A catalog entry's mark, or its monogram when there is no sourced mark. */
export function ConnectorLogo({
    logo,
    name,
    className
}: {
    logo: string;
    name: string;
    className?: string;
}) {
    const Mark = MARKS[logo];
    if (Mark) return <Mark className={cn("shrink-0", className)} />;
    return (
        <span
            aria-hidden="true"
            style={{ backgroundColor: tintFor(logo), color: initialsInk(tintFor(logo)) }}
            className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-[0.25em] text-[0.5em] font-semibold leading-none",
                className
            )}
        >
            {providerInitials(name)}
        </span>
    );
}
