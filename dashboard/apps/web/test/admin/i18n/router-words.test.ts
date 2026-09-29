/**
 * The router guide, in the reader's words.
 *
 * Every brand's advice reads as `lib/router-guide` writes it in English, and in
 * Spanish its own sentences change while the router's menus and buttons stay as
 * the router shows them.
 */

import { describe, expect, it } from "vitest";
import { translatorFor } from "@/lib/i18n/translate";
import { ROUTER_BRANDS, routerGuide } from "@/lib/router-guide";
import { routerGuideIn } from "@/app/(app)/admin/domains/router-words";

const english = translatorFor("en-US", "admin");
const spanish = translatorFor("es-ES", "admin");

describe("the router guide", () => {
    it("reads as the guide writes it, in English", () => {
        for (const guide of ROUTER_BRANDS) expect(routerGuideIn(english, guide)).toEqual(guide);
    });

    it("says its own sentences in Spanish and quotes the router as it is", () => {
        const zte = routerGuideIn(spanish, routerGuide("zte"));
        expect(zte.signIn).toContain("etiqueta");
        expect(zte.forwardPath).toBe("Internet > Security > Port Forwarding");
        const other = routerGuideIn(spanish, routerGuide("other"));
        expect(other.label).toBe("Otra marca");
    });
});
