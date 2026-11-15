import { describe, expect, it } from "vitest";
import {
    authenticationTemplatePayload,
    codeTemplateFrom,
    twilioCodeForm,
    whatsappDigits
} from "@/lib/messaging/whatsapp-template";

describe("WhatsApp authentication template", () => {
    it("carries the code in the body and in the copy-code button, as Meta's example does", () => {
        const payload = authenticationTemplatePayload({
            to: "34600111222@c.us",
            template: { name: "verification_code", language: "es" },
            code: "123456"
        });
        expect(payload).toEqual({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: "34600111222",
            type: "template",
            template: {
                name: "verification_code",
                language: { code: "es" },
                components: [
                    { type: "body", parameters: [{ type: "text", text: "123456" }] },
                    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123456" }] }
                ]
            }
        });
    });

    it("reads the template from a channel's settings, defaulting the language", () => {
        expect(codeTemplateFrom({ codeTemplate: " otp " })).toEqual({ name: "otp", language: "en_US" });
        expect(codeTemplateFrom({ codeTemplate: "otp", codeTemplateLanguage: "es_ES" })).toEqual({
            name: "otp",
            language: "es_ES"
        });
        expect(codeTemplateFrom({})).toBeNull();
        expect(codeTemplateFrom(undefined)).toBeNull();
    });

    it("fills Twilio's Content Template variable 1 with the code", () => {
        const form = twilioCodeForm({ from: "+1 555 0100", to: "34600111222@c.us", contentSid: "HXabc", code: "42" });
        expect(form.get("From")).toBe("whatsapp:+15550100");
        expect(form.get("To")).toBe("whatsapp:+34600111222");
        expect(form.get("ContentSid")).toBe("HXabc");
        expect(JSON.parse(form.get("ContentVariables") ?? "{}")).toEqual({ "1": "42" });
    });

    it("turns a JID or a typed number into digits", () => {
        expect(whatsappDigits("+34 600-111-222")).toBe("34600111222");
        expect(whatsappDigits("34600111222@c.us")).toBe("34600111222");
    });
});
