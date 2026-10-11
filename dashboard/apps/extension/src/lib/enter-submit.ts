/**
 * Whether an Enter press is somebody sending a login that no form will report.
 *
 * Inside a form the browser turns Enter into a submit, which is seen on its own;
 * without one there is no submit and often no button press either, so a sign-in
 * written as a component that sends on Enter is only ever visible here. Limited
 * to the login's own boxes, so Enter in a search field or a chat box is not taken
 * for somebody signing in.
 */
export function enterSendsLogin(
    event: Pick<KeyboardEvent, "key" | "isComposing" | "target">,
    loginBoxes: readonly (HTMLInputElement | null)[]
): boolean {
    if (event.key !== "Enter" || event.isComposing) return false;
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || box.form) return false;
    return loginBoxes.includes(box);
}
