/**
 * A TXT record read back from Cloudflare, as the DNS plan compares it.
 *
 * Read with its quotes, an existing SPF is not recognised as one, the plan
 * publishes a second, and a domain with two SPF records fails SPF everywhere.
 */

import { describe, expect, it } from "vitest";
import { unquoteTxt } from "@/lib/integrations/cloudflare-api";

describe("a TXT record's value", () => {
    it("joins the quoted character-strings it is stored as", () => {
        expect(unquoteTxt('"v=spf1 mx include:_spf.google.com ~all"')).toBe(
            "v=spf1 mx include:_spf.google.com ~all"
        );
        expect(unquoteTxt('"v=DKIM1; k=rsa; " "p=MIIBIjANBgkq"')).toBe(
            "v=DKIM1; k=rsa; p=MIIBIjANBgkq"
        );
        expect(unquoteTxt('"a \\"quoted\\" word"')).toBe('a "quoted" word');
    });

    it("leaves an unquoted value as it is", () => {
        expect(unquoteTxt("v=spf1 -all")).toBe("v=spf1 -all");
    });
});
