/**
 * Draw the app icons from the Polaris mark: `assets/icon.png` (Linux, and the
 * window icon), `assets/icon.ico` (Windows) and `assets/icon.icns` (macOS).
 *
 * Run with Electron itself - `npm run icons` - because Chromium is the one thing
 * already here that renders an SVG exactly; no image library is needed. The
 * `.ico` and `.icns` containers both hold PNG images, which every Windows since
 * Vista and every macOS since 10.7 reads. The results are committed, so a build
 * never runs this.
 *
 * macOS icons sit inside a margin (an 824-pixel body on a 1024 canvas, Apple's
 * grid) so the mark is the size of its neighbours in the Dock; the others fill
 * their square, as Windows and Linux icons do.
 */

const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const MARK = readFileSync(join(ROOT, "src/renderer/mark.svg"));

// Offscreen rendering is drawn in software; with the GPU it can fail to capture.
app.disableHardwareAcceleration();
// Each size has a window of its own, and closing one must not end the run.
app.on("window-all-closed", () => undefined);

/** The mark drawn on a transparent square of `size`, `inset` pixels in from each edge. */
function render(size, inset) {
    const window = new BrowserWindow({
        show: false,
        width: size,
        height: size,
        useContentSize: true,
        frame: false,
        transparent: true,
        webPreferences: { offscreen: true }
    });
    const body = size - inset * 2;
    const html = `<html><body style="margin:0;background:transparent;overflow:hidden"><img style="position:absolute;left:${inset}px;top:${inset}px;width:${body}px;height:${body}px" src="data:image/svg+xml;base64,${MARK.toString("base64")}"></body></html>`;
    return window
        .loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`)
        .then(() => window.webContents.executeJavaScript("document.querySelector('img').decode().then(() => true)"))
        .then(
            () =>
                new Promise((resolve) => {
                    // A frame drawn after the image decoded: ask for one, and take it.
                    window.webContents.on("paint", (_event, _dirty, image) => {
                        if (image.getSize().width !== size) return;
                        window.destroy();
                        resolve(image);
                    });
                    window.webContents.invalidate();
                })
        );
}

function ico(images) {
    const header = Buffer.alloc(6 + images.length * 16);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach(({ size, png }, index) => {
        const at = 6 + index * 16;
        header.writeUInt8(size >= 256 ? 0 : size, at);
        header.writeUInt8(size >= 256 ? 0 : size, at + 1);
        header.writeUInt16LE(1, at + 4);
        header.writeUInt16LE(32, at + 6);
        header.writeUInt32LE(png.length, at + 8);
        header.writeUInt32LE(offset, at + 12);
        offset += png.length;
    });
    return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

function icns(entries) {
    const chunks = entries.map(({ type, png }) => {
        const head = Buffer.alloc(8);
        head.write(type, 0, "ascii");
        head.writeUInt32BE(png.length + 8, 4);
        return Buffer.concat([head, png]);
    });
    const head = Buffer.alloc(8);
    head.write("icns", 0, "ascii");
    head.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
    return Buffer.concat([head, ...chunks]);
}

app.whenReady().then(async () => {
    const full = await render(1024, 0);
    const mac = await render(1024, 100);
    const at = (image, size) => image.resize({ width: size, height: size, quality: "best" }).toPNG();

    writeFileSync(join(ROOT, "assets/icon.png"), at(full, 512));
    writeFileSync(
        join(ROOT, "assets/icon.ico"),
        ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: at(full, size) })))
    );
    writeFileSync(
        join(ROOT, "assets/icon.icns"),
        icns([
            { type: "ic11", png: at(mac, 32) },
            { type: "ic12", png: at(mac, 64) },
            { type: "ic07", png: at(mac, 128) },
            { type: "ic13", png: at(mac, 256) },
            { type: "ic08", png: at(mac, 256) },
            { type: "ic14", png: at(mac, 512) },
            { type: "ic09", png: at(mac, 512) },
            { type: "ic10", png: mac.toPNG() }
        ])
    );
    console.log("icons written to assets/");
    app.quit();
});
