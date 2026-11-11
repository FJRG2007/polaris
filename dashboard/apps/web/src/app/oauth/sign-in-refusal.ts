/**
 * Why a password sign-in was refused, as far as the screen needs to know.
 *
 * `INVALID_ORIGIN` means the page was opened on an address sign-in is not
 * accepted on - the password was never checked - and a 5xx is the server
 * failing; retyping the password fixes neither. Every other refusal keeps the
 * one "wrong email or password" sentence, so the screen tells nobody which
 * accounts exist.
 */
export type SignInRefusal = "credentials" | "address" | "failed";

export function signInRefusal(
    error: { code?: string; status?: number } | null | undefined
): SignInRefusal | null {
    if (!error) return null;
    if (error.code === "INVALID_ORIGIN") return "address";
    if ((error.status ?? 0) >= 500) return "failed";
    return "credentials";
}

type AuthWords = (
    key: "login.invalid" | "login.wrongAddress" | "login.failed",
    values?: { address: string }
) => string;

/** The sentence for a refusal. The address one names where sign-in does work. */
export async function refusalMessage(refusal: SignInRefusal, t: AuthWords): Promise<string> {
    if (refusal === "credentials") return t("login.invalid");
    if (refusal === "failed") return t("login.failed");
    const { signInAddressAction } = await import("./sign-in-address");
    const address = await signInAddressAction().catch(() => null);
    return address ? t("login.wrongAddress", { address }) : t("login.failed");
}
