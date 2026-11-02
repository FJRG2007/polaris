// Collects what the installers carry into stage/vpn-helper. Run from `desktop/`:
//   node vpn-helper/stage.mjs [rust-target] [wireguard-nt folder, on Windows]
// The service copies its files beside itself on install, so the driver keeps the
// relative path the tunnel library loads it from.

import { join } from "node:path";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

const [target, driver] = process.argv.slice(2);
const windows = process.platform === "win32";
const name = windows ? "polaris-vpn-helper.exe" : "polaris-vpn-helper";
const built = join("vpn-helper", "target", target || "", "release", name);
const stage = join("vpn-helper", "stage", "vpn-helper");

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
copyFileSync(built, join(stage, name));

if (windows) {
    if (!driver) throw new Error("Windows needs the wireguard-nt folder.");
    const binaries = join(stage, "resources-windows", "binaries");
    mkdirSync(binaries, { recursive: true });
    copyFileSync(join(driver, "bin", "amd64", "wireguard.dll"), join(binaries, "wireguard-amd64.dll"));
    copyFileSync(join(driver, "LICENSE.txt"), join(stage, "wireguard-nt-LICENSE.txt"));
}
