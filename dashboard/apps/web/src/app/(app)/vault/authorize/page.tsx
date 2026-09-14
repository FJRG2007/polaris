/**
 * Letting a client into this vault (/vault/authorize).
 *
 * The extension's way in. It shows a short code; this is where somebody who is
 * already inside the vault types it and says yes - and the saying yes is what
 * hands over the key, sealed to a public half that extension generated for this
 * one exchange. Polaris never holds anything that could open it.
 *
 * Behind `VaultGate` on purpose, which is the whole security argument: approving
 * requires a Polaris session AND an unlocked vault. That is strictly more than the
 * master password the extension would otherwise have asked somebody to type into a
 * popup, which is the step this replaces.
 */

import { VaultGate } from "../vault-session";
import { AuthorizeView } from "./authorize-view";

export const dynamic = "force-dynamic";

export default function VaultAuthorizePage() {
    // The same width as the vault itself, which holds no container of its own:
    // this screen is reached from inside the vault, and a card half as wide as
    // the one it was opened from reads as a different place.
    return (
        <div className="flex flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Let a client in</h1>
                <p className="text-sm text-muted-foreground">
                    Type the code the app is showing. Nothing is let in until you say so.
                </p>
            </div>
            <VaultGate>
                <AuthorizeView />
            </VaultGate>
        </div>
    );
}
