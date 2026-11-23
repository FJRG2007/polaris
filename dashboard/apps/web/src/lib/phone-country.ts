import { headers } from "next/headers";
import { requestCountry } from "@/lib/request-context";
import { defaultPhoneCountry, type PhoneCountry } from "@polaris/core";

/**
 * The country a phone number typed without its code is read in for this
 * request: where it comes from, else the reader's languages. The same answer
 * the sign-in and the sign-in screen's own checks use.
 */
export async function requestPhoneCountry(): Promise<PhoneCountry> {
    const incoming = await headers();
    const locales = (incoming.get("accept-language") ?? "")
        .split(",")
        .map((part) => part.split(";")[0]!.trim())
        .filter(Boolean)
        .slice(0, 8);
    return defaultPhoneCountry({ server: await requestCountry(), locales });
}
