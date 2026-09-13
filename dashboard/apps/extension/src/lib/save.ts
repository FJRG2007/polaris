/**
 * What somebody typed into "save a login", before any of it is encrypted.
 *
 * One function, used twice: the popup runs it on every keystroke so the button
 * says why it is disabled, and the worker runs it again on what arrives, because
 * the popup is not where a decision is allowed to be final. A check that only
 * happens in the thing being typed into is not validation.
 *
 * It is separate from the worker for the same reason `matching.ts` is: an item
 * saved wrong is not visible anywhere. A name that normalized to nothing, a
 * password with a space quietly removed, an address that is not a page - none of
 * those fail loudly, they just sit in the vault not working.
 */

/** A login on its way into the vault, normalized. */
export interface IntendedLogin {
    readonly name: string;
    readonly username: string | null;
    readonly password: string | null;
    /** The address it is offered on, or null when it is not tied to a page. */
    readonly uri: string | null;
}

/** What somebody typed, exactly as the fields hold it. */
export interface TypedLogin {
    readonly name: string;
    readonly username: string;
    readonly password: string;
    readonly uri: string;
}

export type Intent =
    | { readonly ok: true; readonly login: IntendedLogin }
    | { readonly ok: false; readonly error: string };

/**
 * Read what was typed, or say what is wrong with it in a sentence.
 *
 * The errors are what somebody should do about it rather than which rule failed,
 * because this is the text the popup puts under the button.
 */
export function readIntendedLogin(typed: TypedLogin): Intent {
    const name = typed.name.trim();
    if (name === "") return { ok: false, error: "Give it a name so you can find it again." };

    const uri = typed.uri.trim();
    if (uri !== "" && !/^https?:\/\//i.test(uri)) {
        return { ok: false, error: "The address has to be a web page." };
    }

    const username = typed.username.trim();
    // The password is deliberately NOT trimmed. A leading or trailing space is
    // legal in a password, plenty of people have one, and a client that quietly
    // removes it saves a credential that does not work - then shows it filling the
    // form correctly, because what it stored is what it types.
    const password = typed.password;

    if (username === "" && password === "") {
        return { ok: false, error: "Add a username or a password: there is nothing to save yet." };
    }

    return {
        ok: true,
        login: {
            name,
            username: username === "" ? null : username,
            password: password === "" ? null : password,
            uri: uri === "" ? null : uri
        }
    };
}
