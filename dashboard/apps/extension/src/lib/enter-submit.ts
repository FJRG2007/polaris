/** Input types whose presence in a form stops Enter submitting it when there is no button. */
const BLOCKING_TYPES = new Set([
    "text",
    "search",
    "url",
    "tel",
    "email",
    "password",
    "date",
    "month",
    "week",
    "time",
    "datetime-local",
    "number"
]);

/**
 * Whether Enter in a box makes the browser submit its form, per the HTML
 * implicit-submission rules: through the form's default button when it has one
 * that is enabled, or on its own when it is the only field that could block it.
 */
function enterSubmitsForm(form: HTMLFormElement): boolean {
    const controls = Array.from(form.elements);
    const button = controls.find(
        (control): control is HTMLButtonElement | HTMLInputElement =>
            (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) &&
            (control.type === "submit" || control.type === "image")
    );
    if (button) return !button.disabled;
    const blocking = controls.filter(
        (control) => control instanceof HTMLInputElement && BLOCKING_TYPES.has(control.type)
    );
    return blocking.length === 1;
}

/**
 * Whether an Enter press is somebody sending a login that no form will report.
 *
 * Where the browser turns Enter into a submit, that is seen on its own; without
 * a form, or in one Enter cannot submit, there is no submit and often no button
 * press either, so a sign-in written as a component that sends on Enter is only
 * ever visible here. Limited to the login's own boxes, so Enter in a search
 * field or a chat box is not taken for somebody signing in, and a held key is
 * one press.
 */
export function enterSendsLogin(
    event: Pick<KeyboardEvent, "key" | "isComposing" | "repeat" | "target">,
    loginBoxes: readonly (HTMLInputElement | null)[]
): boolean {
    if (event.key !== "Enter" || event.isComposing || event.repeat) return false;
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || (box.form && enterSubmitsForm(box.form)))
        return false;
    return loginBoxes.includes(box);
}
