# Install Polaris TV

[Leer en español](polaris-tv-install.es.md) - [Back to the README](../../README.md)

Polaris TV goes on the TV from the Polaris desktop app, on a computer on the same network as the TV or
connected to it by USB cable. The steps are the same for every TV: what differs by brand, the app works
out from the TV it finds.

## 1. Click Install

Open the Polaris desktop app, go to Downloads > Polaris TV > Install on a TV and click **Install**. The app
finds the TVs on your network, or takes the TV's address (Settings > Network on the TV shows it), or the
TV plugged in on the USB cable tab.

## 2. Turn on debugging, only if the app asks

When debugging is still off, the app shows one instruction for that TV: which item to press OK on seven
times, and which switch to turn on in Developer options. Do it on the TV. The app notices by itself and
carries on, so there is nothing to retry.

## 3. Accept on the TV

The TV asks "Allow USB debugging?". Choose **Allow**; if nobody answers, it asks again. The app then saves
a backup of the TV's settings on the computer, installs Polaris TV and turns debugging off again.

## What the app decides for you

- **Fire TV** (Fire OS 6 or newer): Polaris TV is an app you open, because Amazon keeps the Home button.
  The 2015 Fire TV box on Fire OS 5 cannot install it.
- **Huawei (HarmonyOS) and Kalley**: Polaris TV is not made the Home screen. On one of each, that left
  the set unable to start.
- **TCL**: the app lets Polaris TV start on its own, which TCL's firmware blocks otherwise.
- **Older than Android 8, or not Android**: the app says so. These TVs can still
  [block ads for the whole home](polaris-tv-network.md).
- **Chromecast with Google TV and Google TV Streamer** turn on debugging only with a Wireless debugging
  pairing code, which the app cannot use yet. Install over a USB cable if the device has a data port, or
  block ads for the whole home instead.

See also: [Does it work on my TV?](polaris-tv-compatibility.md) and the
[privacy switches by brand](polaris-tv-privacy.md).
