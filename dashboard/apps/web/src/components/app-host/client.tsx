"use client";

/**
 * What the dashboard offers installable apps in the browser: the shared
 * components, hooks and helpers of its shell. The client half of
 * `lib/app-host/server.ts`, and a contract in the same way.
 *
 * Provided when this module is evaluated, which the dashboard's layout
 * guarantees by rendering `ProvideAppHostUi` above every app's screens.
 */

import { provideAppHostUi } from "@polaris/app-host/client";
import { ShareDialog } from "@/components/access/share-dialog";
import { TpLinkMark } from "@/components/brand-icons";
import { useDisplayFormat } from "@/components/display-format";
import { IntegrationLogo } from "@/components/logos";
import { MediaPlayer } from "@/components/media-player";
import { runAction } from "@/lib/run-action";

export const clientHost = {
    accessShareDialog: { ShareDialog },
    brandIcons: { TpLinkMark },
    displayFormat: { useDisplayFormat },
    logos: { IntegrationLogo },
    mediaPlayer: { MediaPlayer },
    runAction: { runAction }
};

type ClientHost = typeof clientHost;

declare module "@polaris/app-host/client" {
    interface AppHostUi extends ClientHost {}
}

provideAppHostUi(clientHost);

/** Rendered by the layout so this module is loaded before any app's screen. */
export function ProvideAppHostUi(): null {
    return null;
}
