#!/bin/sh
# The .deb's post-removal script: takes back the browser manifests the app wrote
# for its native messaging host (src/main/native-host/manifests.ts) and the copy
# of the host beside its socket, for every user on the computer. Only files with
# those exact names are removed; an upgrade keeps them.

set -e

case "$1" in
    remove | purge) ;;
    *) exit 0 ;;
esac

name=local.polaris.desktop.json
for home in /root /home/*; do
    [ -d "$home" ] || continue
    rm -f -- \
        "$home/.config/google-chrome/NativeMessagingHosts/$name" \
        "$home/.config/chromium/NativeMessagingHosts/$name" \
        "$home/.config/microsoft-edge/NativeMessagingHosts/$name" \
        "$home/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/$name" \
        "$home/.mozilla/native-messaging-hosts/$name" \
        "$home/.config/Polaris/native-host/polaris-native-host"
done
exit 0
