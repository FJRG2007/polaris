"use client";

/**
 * The little square beside an item in the list.
 *
 * Three answers, in order, and the order is the whole design.
 *
 * A brand Polaris already ships a mark for wins, because that mark is the
 * vendor's own artwork, it is already in the bundle, it needs no network, and it
 * is right in both themes. Recognised from the address and from the name, since
 * an item called "Amazon Web Services" with no URL on it is still obviously AWS.
 *
 * Then the site's own favicon, when the item names a website and the vault has
 * been told it may fetch them. That is off by default and it is not a
 * preference, it is a disclosure: the request goes from this browser to that
 * site, and a site that receives it learns somebody with a Polaris vault has an
 * account there. It never goes through the server - a server that fetched
 * favicons would be a server that learns every domain in a vault it is not
 * supposed to be able to read - and it never goes through a third-party icon
 * service for the same reason.
 *
 * Then the letters, which always work: two characters off the domain, on a
 * colour derived from it, so the same site is the same square every time and two
 * items are told apart before either name is read.
 */

import { cn } from "@polaris/ui";
import { useState } from "react";
import * as core from "@polaris/core";
import type { VaultItem } from "./vault-model";
import { CloudflareMark, DockerMark, GitHubMark, GoogleMark, NgrokMark } from "@/components/brand-icons";

/**
 * Brands worth recognising by name as well as by address.
 *
 * Deliberately short and deliberately Polaris': these are the marks the
 * dashboard already ships for its own screens, and this reuses them rather than
 * starting a logo collection that would need a licence audit and a size budget.
 * Everything else falls through to the favicon or the letters, which are
 * perfectly good answers.
 */
const KNOWN: readonly {
    readonly test: RegExp;
    readonly Mark: (props: { className?: string }) => React.ReactElement;
}[] = [
    { test: /(^|\.)github\.com$|^github$/i, Mark: GitHubMark },
    { test: /(^|\.)google\.com$|^google$/i, Mark: GoogleMark },
    { test: /(^|\.)cloudflare\.com$|^cloudflare$/i, Mark: CloudflareMark },
    { test: /(^|\.)docker\.com$|^docker$/i, Mark: DockerMark },
    { test: /(^|\.)ngrok\.com$|^ngrok$/i, Mark: NgrokMark }
];

/** The colour behind the letters. From the domain rather than the name, so the
 *  same site is the same colour on every item that points at it. */
function tint(seed: string): string {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
        hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
    }
    return `hsl(${hash % 360} 36% 42%)`;
}

export function ItemIcon({
    item,
    favicons,
    className
}: {
    item: VaultItem;
    /** Whether this vault has been told it may fetch a site's own favicon. Off
     *  by default: it tells that site somebody has an account there. */
    favicons: boolean;
    className?: string;
}) {
    const [failed, setFailed] = useState(false);
    const host = core.hostOf(item.login.uris[0]?.uri ?? "");
    const chosen = core.fieldValue(item.fields, core.ICON_FIELD).trim();
    const size = cn("size-7 shrink-0 overflow-hidden rounded-md", className);

    // What somebody chose themselves, which is one or two characters and needs
    // nothing fetched.
    if (chosen) {
        return (
            <span
                className={cn(size, "grid place-items-center bg-muted text-sm")}
                aria-hidden="true"
            >
                {chosen.slice(0, 2)}
            </span>
        );
    }

    const known = KNOWN.find((entry) => entry.test.test(host ?? item.name.trim()));
    if (known) {
        return (
            <span className={cn(size, "grid place-items-center bg-muted")} aria-hidden="true">
                <known.Mark className="size-4" />
            </span>
        );
    }

    if (favicons && host && !failed) {
        return (
            // eslint-disable-next-line @next/next/no-img-element -- one small icon per row, no loader wanted
            <img
                src={`https://${host}/favicon.ico`}
                alt=""
                onError={() => setFailed(true)}
                className={cn(size, "bg-muted object-contain p-1")}
                // Nothing about this page travels with the request.
                referrerPolicy="no-referrer"
                loading="lazy"
            />
        );
    }

    return (
        <span
            className={cn(size, "grid place-items-center text-[0.625rem] font-medium text-white")}
            style={{ backgroundColor: tint(host ?? item.name) }}
            aria-hidden="true"
        >
            {core.itemInitials(item.name, host)}
        </span>
    );
}
