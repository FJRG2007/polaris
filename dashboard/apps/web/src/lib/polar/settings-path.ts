/** Polar's settings page, and where the address it replaced lands. */

export const POLAR_SETTINGS_PATH = "/polar/settings";

/**
 * Where /account/polar-tools sends a visit: the connectors with the sign-in
 * answer it carried, or the permissions it used to show.
 */
export function polarToolsTarget(connector: string | string[] | undefined): string {
    return connector === "signed_in" || connector === "failed"
        ? `${POLAR_SETTINGS_PATH}?connector=${connector}#connectors`
        : `${POLAR_SETTINGS_PATH}#permissions`;
}
