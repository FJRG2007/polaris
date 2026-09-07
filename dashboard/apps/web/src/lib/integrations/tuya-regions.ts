/**
 * Tuya's data centres, as a list anything may read.
 *
 * Apart from the API client because both sides of the app need it and only one of
 * them may have the client: the screen that asks which data centre a project is
 * in draws these in a browser, and `tuya-api` signs requests with node's crypto.
 * A client component that reached the list through it pulled `node:crypto` into
 * the browser bundle, and the build failed with a webpack error that named
 * neither file.
 *
 * Pure. No credentials, no network, nothing but their addresses.
 */

/**
 * Where an account's devices live.
 *
 * Not a preference: a project is created in one data centre and its devices exist
 * in that one only, so asking anywhere else answers as though the account were
 * empty. It is on the developer console's own front page, which is why the field
 * asks for it in those words.
 */
export const TUYA_REGIONS = [
    { value: "eu", label: "Central Europe", host: "https://openapi.tuyaeu.com" },
    { value: "weu", label: "Western Europe", host: "https://openapi-weaz.tuyaeu.com" },
    { value: "us", label: "Western America", host: "https://openapi.tuyaus.com" },
    { value: "eus", label: "Eastern America", host: "https://openapi-ueaz.tuyaus.com" },
    { value: "cn", label: "China", host: "https://openapi.tuyacn.com" },
    { value: "in", label: "India", host: "https://openapi.tuyain.com" }
] as const;

export type TuyaRegion = (typeof TUYA_REGIONS)[number]["value"];

/** The address for a region, falling back to one rather than to no host at all: a
 *  stored value from a build that knew a region this one does not is still an
 *  account somebody expects to see. */
export function tuyaHost(region: string): string {
    return TUYA_REGIONS.find((entry) => entry.value === region)?.host ?? TUYA_REGIONS[0].host;
}
