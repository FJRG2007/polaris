// jsdom lays nothing out: every box measures 0x0, and a test gives one a size by
// replacing `getBoundingClientRect`. The list virtualizer reads its scroll
// container's `clientWidth`/`clientHeight` and each row's `offsetHeight`
// instead, which jsdom pins at 0, so those follow the measured box here and one
// stand-in sizes them all.
const follow = (target: object, sides: Record<string, "width" | "height">) => {
    for (const [key, side] of Object.entries(sides)) {
        Object.defineProperty(target, key, {
            configurable: true,
            get(this: Element) {
                return this.getBoundingClientRect()[side];
            }
        });
    }
};

if (typeof HTMLElement !== "undefined") {
    follow(Element.prototype, { clientWidth: "width", clientHeight: "height" });
    follow(HTMLElement.prototype, { offsetWidth: "width", offsetHeight: "height" });
}
