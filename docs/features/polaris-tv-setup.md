# Set up an Android or Google TV in three steps

[Leer en español](polaris-tv-setup.es.md) - [Back to the README](../../README.md)

Polaris TV goes on the TV from the Polaris desktop app, on a computer on the same network as the TV or
connected to it by USB cable. Nothing is typed on the computer beyond the TV's address.

## 1. Turn on debugging on the TV

1. Open Settings > Device Preferences > About (System > About on some sets) and press OK on **Build**
   seven times, until the TV says you are a developer.
2. Back in Device Preferences (or System), open **Developer options** and turn on **USB debugging**.
3. To install over the network, also turn on **Network debugging** or **Wireless debugging**, whichever
   the TV has.

## 2. Install from the desktop app

Open the Polaris desktop app and go to Downloads > Polaris TV > Install on a TV. It finds the TVs on your
network, or takes the TV's address (Settings > Network on the TV shows it). Leave "Make it the Home
screen" on to replace the TV's Home screen; the TV's own stays installed.

## 3. Accept on the TV

The TV asks "Allow USB debugging?". Accept it. The desktop app then saves a backup of the TV's settings
on the computer, installs Polaris TV and, at the end, turns network debugging off again.

## Sets that need one more step

- **Chromecast with Google TV and Google TV Streamer** keep the usual debugging port closed. Turn on
  **Wireless debugging** and pair with the code the TV shows. It closes again after every restart.
- **TCL** sets can stop a launcher from starting on its own. The desktop app allows it during the install.
- **Huawei (HarmonyOS) and the Kalley 43G200**: leave "Make it the Home screen" off. On one of each, the
  switch left the set unable to start.

See also: [Does it work on my TV?](polaris-tv-compatibility.md) and the
[privacy switches by brand](polaris-tv-privacy.md).
