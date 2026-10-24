/** Status pages: the public pages that say how each service is doing. */

import { Chrome } from "../runtime/chrome";
import { defineScene } from "../runtime/scene";
import { id } from "../fixtures/people";
import { StatusPagesScreen } from "../../../apps/status-pages/src/screens/manager";

export const statusPages = defineScene({
    id: "status-pages",
    path: "/status-pages",
    actions: (ctx) => ({
        listPagesAction: () => ({
            ok: true,
            pages: [
                {
                    slug: "shop",
                    title: ctx.say("Shop status", "Estado de la tienda"),
                    published: true,
                    components: 6,
                    openIncidents: 1
                },
                { slug: "api", title: "API", published: true, components: 4, openIncidents: 0 },
                {
                    slug: "internal",
                    title: ctx.say("Internal tools", "Herramientas internas"),
                    published: false,
                    components: 3,
                    openIncidents: 0
                }
            ].map((page, n) => ({ id: id("status-page", n + 1), ...page }))
        })
    }),
    // The page `/status-pages` draws: the screen the app serves at its root.
    render: () => (
        <Chrome>
            <StatusPagesScreen pageId={null} manager />
        </Chrome>
    )
});
