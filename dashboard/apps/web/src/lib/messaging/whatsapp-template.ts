/**
 * What a one-time code looks like on WhatsApp's Business API.
 *
 * A business may only open a conversation - and a sign-in code always opens one -
 * with a template Meta approved; free text is accepted only inside the 24 hours
 * after the person last wrote. Codes therefore go through an approved
 * AUTHENTICATION template, whose copy-code button repeats the code: Meta's send
 * example carries it twice, once in the body and once in the button
 * (developers.facebook.com/docs/whatsapp/business-management-api/authentication-templates/copy-code-button-authentication-templates).
 *
 * Pure, so the payloads can be asserted in a test.
 */

/** The digits of a number as the Business API wants it, from a JID or a typed number. */
export function whatsappDigits(peerId: string): string {
    return peerId.replace(/@.*$/, "").replace(/\D/g, "");
}

/** The authentication template a channel sends codes with, from its stored config. */
export interface CodeTemplate {
    name: string;
    language: string;
}

/** Used when a template is named without a language: Meta's own example locale. */
export const DEFAULT_TEMPLATE_LANGUAGE = "en_US";

/** The template named in a channel's provider config, or null when none is set. */
export function codeTemplateFrom(config: Record<string, string> | undefined): CodeTemplate | null {
    const name = config?.codeTemplate?.trim();
    if (!name) return null;
    return { name, language: config?.codeTemplateLanguage?.trim() || DEFAULT_TEMPLATE_LANGUAGE };
}

/** The Cloud API (and 360dialog, which takes the same body) request for one code. */
export function authenticationTemplatePayload(input: { to: string; template: CodeTemplate; code: string }) {
    return {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: whatsappDigits(input.to),
        type: "template",
        template: {
            name: input.template.name,
            language: { code: input.template.language },
            components: [
                { type: "body", parameters: [{ type: "text", text: input.code }] },
                {
                    type: "button",
                    sub_type: "url",
                    index: "0",
                    parameters: [{ type: "text", text: input.code }]
                }
            ]
        }
    };
}

/** A plain text message on the Cloud API (only delivered inside the 24-hour window). */
export function cloudTextPayload(to: string, text: string) {
    return { messaging_product: "whatsapp", to: whatsappDigits(to), type: "text", text: { body: text } };
}

/** `whatsapp:+<digits>`, the address form Twilio's WhatsApp sender expects. */
export function twilioAddress(number: string): string {
    return `whatsapp:+${whatsappDigits(number)}`;
}

/**
 * Twilio's form for one code: the approved template is a Content SID (HX...), and
 * the code fills its `{{1}}` (twilio.com/docs/messaging/api/message-resource).
 */
export function twilioCodeForm(input: {
    from: string;
    to: string;
    contentSid: string;
    code: string;
}): URLSearchParams {
    return new URLSearchParams({
        From: twilioAddress(input.from),
        To: twilioAddress(input.to),
        ContentSid: input.contentSid,
        ContentVariables: JSON.stringify({ "1": input.code })
    });
}
