/**
 * Polar's administrator settings, drawn by Polaris apps > Polar > Settings.
 * The caller has already checked that the reader is an administrator.
 */

import { polarCodeAdmin } from "./data";
import { PolarCodeView } from "./polar-code-view";

export async function PolarAdminSettings() {
    return <PolarCodeView initial={await polarCodeAdmin()} />;
}
