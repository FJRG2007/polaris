#!/usr/bin/env bash
# Publish the installable apps' bundles next to the dashboard image, and name
# the ones the latest dashboard uses.
#
#   app-bundles.sh push <dir>      upload every bundle in <dir> (the Dockerfile's
#                                  `app-bundles` stage), untagged, by digest
#   app-bundles.sh tag <json>      tag each bundle `latest-app-<id>`; <json> is
#                                  {"<id>": "<manifest digest>", ...}
#
# A bundle is an OCI artifact in the dashboard's own package: the zip as its one
# layer, under the manifest the bundler wrote (so its digest is the one the image
# names). The dashboard downloads the zip by digest and checks it against the
# index built into the image; nothing here is trusted by the dashboard beyond
# being the bytes that hash to that digest.
#
# Pushed untagged first, like the image, and tagged by the same job that moves
# `latest`: ghcr-prune.yml keeps what `latest` and the `latest-app-*` tags name,
# plus anything pushed in the last hour, and deletes the rest.
#
# Needs REGISTRY_USER and REGISTRY_TOKEN (a token that can write the package).

set -euo pipefail

REGISTRY=ghcr.io
REPOSITORY=${APP_BUNDLES_REPOSITORY:-fjrg2007/polaris-dashboard}
API="https://$REGISTRY/v2/$REPOSITORY"
MANIFEST_TYPE=application/vnd.oci.image.manifest.v1+json

token=$(curl -fsS -u "$REGISTRY_USER:$REGISTRY_TOKEN" \
    "https://$REGISTRY/token?service=$REGISTRY&scope=repository:$REPOSITORY:pull,push" | jq -r .token)
[ -n "$token" ] && [ "$token" != null ] || { echo "no registry token"; exit 1; }
auth="Authorization: Bearer $token"

sha() { echo "sha256:$(sha256sum "$1" | cut -d' ' -f1)"; }

# Upload a file as a blob unless the registry already has it.
push_blob() {
    local file=$1 digest=$2 location separator
    if curl -fsS -o /dev/null -I -H "$auth" "$API/blobs/$digest"; then
        echo "  $digest already published"
        return 0
    fi
    location=$(curl -fsS -X POST -D - -o /dev/null -H "$auth" "$API/blobs/uploads/" \
        | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')
    [ -n "$location" ] || { echo "the registry gave no upload address"; return 1; }
    case "$location" in http*) ;; *) location="https://$REGISTRY$location" ;; esac
    case "$location" in *\?*) separator='&' ;; *) separator='?' ;; esac
    curl -fsS -o /dev/null -X PUT -H "$auth" -H "Content-Type: application/octet-stream" \
        --data-binary "@$file" "$location${separator}digest=$digest"
    echo "  uploaded $digest"
}

put_manifest() {
    curl -fsS -o /dev/null -X PUT -H "$auth" -H "Content-Type: $MANIFEST_TYPE" \
        --data-binary "@$1" "$API/manifests/$2"
}

push() {
    local dir=$1 empty id file digest manifest
    empty=$(mktemp)
    printf '{}' > "$empty"
    push_blob "$empty" "$(sha "$empty")"
    for id in $(jq -r '.apps | keys[]' "$dir/index.json"); do
        echo "$id"
        file="$dir/$(jq -r --arg id "$id" '.apps[$id].file' "$dir/index.json")"
        digest=$(jq -r --arg id "$id" '.apps[$id].digest' "$dir/index.json")
        manifest=$(jq -r --arg id "$id" '.apps[$id].manifest' "$dir/index.json")
        # The bytes the image names, or nothing is published.
        [ "$(sha "$file")" = "$digest" ] || { echo "$file is not $digest"; exit 1; }
        [ "$(sha "$dir/$id.oci.json")" = "$manifest" ] || { echo "$id.oci.json is not $manifest"; exit 1; }
        push_blob "$file" "$digest"
        put_manifest "$dir/$id.oci.json" "$manifest"
        echo "  published $manifest"
    done
    rm -f "$empty"
}

tag() {
    local list=$1 id digest body
    body=$(mktemp)
    for id in $(jq -r 'keys[]' <<<"$list"); do
        digest=$(jq -r --arg id "$id" '.[$id]' <<<"$list")
        curl -fsS -H "$auth" -H "Accept: $MANIFEST_TYPE" -o "$body" "$API/manifests/$digest"
        [ "$(sha "$body")" = "$digest" ] || { echo "the registry answered something else for $digest"; exit 1; }
        put_manifest "$body" "latest-app-$id"
        echo "latest-app-$id -> $digest"
    done
    rm -f "$body"
}

case "${1:-}" in
    push) push "$2" ;;
    tag) tag "$2" ;;
    *) echo "usage: $0 push <dir> | tag <json>"; exit 2 ;;
esac
