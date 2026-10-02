#!/usr/bin/env bash
# Runs inside the build container (see build.sh). Mirrors the builder's
# scripts/prepare-build.sh for a single AW1000 profile:
#   1. feeds.conf = default + build/feeds, installed custom feeds first
#   2. local feed patches (builder's edma-nss ones, then ours)
#   3. .config = builder common config + build/config, verified after defconfig
#   4. builder overlay files, then make

set -euo pipefail

STEP="${1:-all}"
FEED=/work/aw1000-feed
BUILDER=/work/builder-reference
COMMON="$BUILDER/devices/common"

cd /work/openwrt

log() { printf '\n==> %s\n' "$*"; }

# 1. Feeds
log "feeds.conf"
cp feeds.conf.default feeds.conf
grep -vE '^\s*(#|$)' "$FEED/build/feeds" >>feeds.conf
cat feeds.conf

./scripts/feeds update -a

custom="$(grep -vE '^\s*(#|$)' "$FEED/build/feeds" | awk '{print $2}')"
for f in $custom; do
	log "install feed $f"
	./scripts/feeds install -a -p "$f"
done
log "install remaining feeds"
./scripts/feeds install -a

for pkg in $(grep -vE '^\s*(#|$)' "$FEED/build/feeds.exclude"); do
	log "exclude $pkg"
	rm -f "package/feeds/$pkg"
done

# 2. Feed patches: <dir>/<feed>/*.patch, paths relative to the feed root.
apply_patches() {
	local p feed
	shopt -s nullglob
	for p in "$1"/*/*.patch; do
		feed="feeds/$(basename "$(dirname "$p")")"
		if patch -p1 -d "$feed" --dry-run --forward <"$p" >/dev/null 2>&1; then
			log "patch $feed: $(basename "$p")"
			patch -p1 -d "$feed" --forward <"$p"
		elif patch -p1 -d "$feed" --dry-run --reverse <"$p" >/dev/null 2>&1; then
			echo "already applied: $(basename "$p")"
		else
			echo "does not apply to $feed: $p" >&2
			exit 1
		fi
	done
	shopt -u nullglob
}
apply_patches "$BUILDER/patches/feeds/edma-nss"
apply_patches "$FEED/build/patches"

# 3. .config
log ".config"
configs=("$COMMON/config" "$FEED/build/config")
cat "${configs[@]}" >.config
make defconfig

dropped=()
while IFS= read -r req; do
	grep -qxF "$req" .config || dropped+=("$req")
done < <(cat "${configs[@]}" |
	grep -E '^CONFIG_[A-Za-z0-9_-]+=' |
	awk -F= '{ last[$1] = $0 } END { for (s in last) print last[s] }' |
	grep -vE '=n$')
if ((${#dropped[@]})); then
	echo "defconfig dropped requested symbols:" >&2
	printf '  %s\n' "${dropped[@]}" >&2
	exit 1
fi

# Requested off: fail if something pulled them back in.
for sym in CONFIG_PACKAGE_uqmi CONFIG_PACKAGE_kmod-usb-net-qmi-wwan; do
	if grep -qE "^${sym}=[ym]" .config; then
		echo "$sym came back on; something depends on it:" >&2
		exit 1
	fi
done

# Custom feeds are not offered as package repositories on the router.
for f in $custom; do
	sed -i "s/^CONFIG_FEED_${f}=.*/# CONFIG_FEED_${f} is not set/" .config
done

# 4. Overlay files
log "overlay files"
rm -rf files
mkdir -p files
for src in "$COMMON/files" "$COMMON/files.edma-nss"; do
	[[ -d "$src" ]] && cp -a "$src/." files/
done
[[ -f files/etc/ssh/sshd_config ]] && chmod 0600 files/etc/ssh/sshd_config

[[ "$STEP" = prepare ]] && exit 0

log "download"
make download -j8

log "build"
make -j"$(nproc)" || make -j1 V=s

log "images"
ls -l bin/targets/qualcommax/ipq807x/*aw1000* 2>/dev/null
