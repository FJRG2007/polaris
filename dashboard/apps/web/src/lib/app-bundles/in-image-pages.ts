/**
 * The installed apps' pages as this image compiled them.
 *
 * Imported whole, not loaded on first use: Next learns which client components
 * a page may draw by following the page's imports, and a page reached only
 * through `import()` would render with none of them. See `in-image.ts`.
 */

import "@/lib/app-host/server";
import * as page0 from "@polaris-app/places/src/routes/places/alerts/page";
import * as page1 from "@polaris-app/places/src/routes/places/cameras/page";
import * as page2 from "@polaris-app/places/src/routes/places/clips/page";
import * as page3 from "@polaris-app/places/src/routes/places/devices/page";
import * as page4 from "@polaris-app/places/src/routes/places/events/page";
import * as page5 from "@polaris-app/places/src/routes/places/page";
import * as page6 from "@polaris-app/places/src/routes/places/people/page";
import * as page7 from "@polaris-app/places/src/routes/places/settings/page";
import * as page8 from "@polaris-app/game-servers/src/routes/apps/games/page";

type PageModule = Record<string, unknown>;

export const IN_IMAGE_PAGES: Readonly<Record<string, Readonly<Record<string, PageModule>>>> = {
    home: {
        "/places/alerts": page0,
        "/places/cameras": page1,
        "/places/clips": page2,
        "/places/devices": page3,
        "/places/events": page4,
        "/places": page5,
        "/places/people": page6,
        "/places/settings": page7
    },
    "game-servers": {
        "/apps/games": page8
    }
};
