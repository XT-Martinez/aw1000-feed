#!/usr/bin/env bash
# Host side of "build.sh release": after a build without ../private-files,
# check that nothing site-specific reached the image, then copy the images
# with fresh sha256sums to ../release/<name>/.
#
# The check, when ../private-files exists:
#   - no private file is in the image's root under the same path with the
#     same contents;
#   - none of its secrets and identifiers (Wi-Fi keys and SSIDs, WireGuard
#     keys and endpoints, MAC addresses, SSH keys) appears anywhere in the
#     build root or in the root filesystem unpacked from the sysupgrade image.
# Only file names are printed, never the values.

set -euo pipefail

FEED_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
TOP="$(cd -- "$FEED_DIR/.." && pwd)"
OWRT="$TOP/openwrt"
PRIVATE="$TOP/private-files"
BIN="$OWRT/bin/targets/qualcommax/ipq807x"
ROOT="$OWRT/build_dir/target-aarch64_cortex-a53_musl/root-qualcommax"
PREFIX=openwrt-qualcommax-ipq807x-arcadyan_aw1000

log() { printf '\n==> %s\n' "$*"; }
fail() { echo "release: $*" >&2; exit 1; }

IMAGES=(
	"$PREFIX-initramfs-uImage.itb"
	"$PREFIX-squashfs-sysupgrade.bin"
	"$PREFIX-squashfs-factory.ubi"
	"$PREFIX.manifest"
)
for f in "${IMAGES[@]}"; do
	[[ -f "$BIN/$f" ]] || fail "missing $BIN/$f"
done
[[ -d "$ROOT" ]] || fail "missing $ROOT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "unpack the sysupgrade root filesystem"
tar -xf "$BIN/$PREFIX-squashfs-sysupgrade.bin" -C "$TMP"
# Device nodes cannot be created without root; their absence does not matter.
unsquashfs -q -no-progress -no-xattrs -ignore-errors -no-exit-code -d "$TMP/rootfs" "$TMP"/sysupgrade-*/root >/dev/null 2>&1
[[ -f "$TMP/rootfs/etc/openwrt_release" ]] || fail "unpacked root has no /etc/openwrt_release"

if [[ -d "$PRIVATE" ]]; then
	log "check for site files"
	leaks=0
	while IFS= read -r -d '' f; do
		rel="${f#"$PRIVATE"/}"
		[[ "$rel" = .gitignore ]] && continue
		for r in "$ROOT" "$TMP/rootfs"; do
			if { [[ -L "$f" && -L "$r/$rel" ]] && [[ "$(readlink "$f")" = "$(readlink "$r/$rel")" ]]; } ||
				{ [[ -f "$f" && ! -L "$f" && -f "$r/$rel" ]] && cmp -s "$f" "$r/$rel"; }; then
				echo "  site file in the image: /$rel" >&2
				leaks=1
			fi
		done
	done < <(find "$PRIVATE" \( -type f -o -type l \) -print0)

	# Values of the uci options that identify the site, and SSH key blobs.
	pat="$TMP/patterns"
	sed -nE "s/^\s*option\s+(key|private_key|preshared_key|public_key|endpoint_host|ssid|mac|macaddr)\s+'?([^']+)'?\s*$/\2/p" \
		"$PRIVATE"/etc/config/* 2>/dev/null >"$pat" || true
	cat "$PRIVATE"/etc/dropbear/authorized_keys "$PRIVATE"/root/.ssh/authorized_keys 2>/dev/null |
		awk '$2 ~ /^AAAA/ { print $2 }' >>"$pat" || true
	# Short values (a key index, "1") would match everywhere.
	awk 'length($0) >= 6' "$pat" | sort -u >"$pat.long"
	echo "  $(wc -l <"$pat.long") values to look for"
	if [[ -s "$pat.long" ]]; then
		hits="$(grep -rlaF -f "$pat.long" "$ROOT" "$TMP/rootfs" 2>/dev/null || true)"
		if [[ -n "$hits" ]]; then
			echo "  site values found in:" >&2
			sed "s|^$TMP/rootfs|  (sysupgrade) |; s|^$ROOT|  (build root) |" <<<"$hits" >&2
			leaks=1
		fi
	fi
	((leaks == 0)) || fail "site data in the image; not releasing"
	echo "  none found"
else
	echo "no $PRIVATE: nothing site-specific to look for"
fi

rev="$(cat "$BIN/version.buildinfo")"
name="aw1000-nss-$(date +%Y%m%d)-${rev##*-}"
out="$TOP/release/$name"

log "collect into $out"
rm -rf "$out"
mkdir -p "$out"
for f in "${IMAGES[@]}"; do
	cp "$BIN/$f" "$out/"
done
cp "$BIN/config.buildinfo" "$BIN/feeds.buildinfo" "$BIN/version.buildinfo" "$out/"
{
	echo "OpenWrt $rev (openwrt-nss-edma), built $(date -u +%Y-%m-%dT%H:%MZ)"
	for d in openwrt nss-packages builder-reference aw1000-feed; do
		printf '%-18s %s\n' "$d" "$(git -C "$TOP/$d" log -1 --format='%h %s' 2>/dev/null || echo '-')"
	done
} >"$out/SOURCES.txt"
(cd "$out" && sha256sum -- * >sha256sums)

ls -l "$out"
cat "$out/sha256sums"
