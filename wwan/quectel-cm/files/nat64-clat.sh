#!/bin/sh
# shellcheck shell=busybox disable=1091,3043
#
# Translate IPv4 on the router for as long as the quectel proto announces a
# NAT64 prefix, so that every LAN host reaches IPv4 over an IPv6-only data
# call, not only the ones whose OS ships a CLAT of its own. The CLAT is a
# 464xlat interface on top of the modem's interface, given the prefix the proto
# found in the carrier's DNS64 instead of looking it up through the router's own
# resolver, which forwards to whatever upstream the LAN uses and so need not be
# a DNS64 at all. Where nss-wifi-drv runs, its connections are carried in the
# NSS firmware like any other routed traffic.
#
# On by default when 464xlat is installed; turned off per modem interface with
#   uci set network.<interface>.clat='0'
# which leaves the PREF64 announcement, and the clients' own CLATs, as they are.

[ "$ACTION" = nat64 ] || [ "$ACTION" = nat64_stop ] || exit 0
[ -f /lib/netifd/proto/464xlat.sh ] || exit 0

. /lib/functions.sh
. /usr/share/libubox/jshn.sh

CLAT="${INTERFACE}_4"
STATE="/var/run/quectel/$INTERFACE.clat"

clat_remove() {
	[ -f "$STATE" ] || return 0

	rm -f "$STATE"
	ubus call "network.interface.$CLAT" remove 2>/dev/null
	logger -t quectel-clat "removed $CLAT"
}

wanted() {
	local enabled passthrough IPV4_ADDRESS

	[ "$ACTION" = nat64 ] && [ -n "$PREFIX" ] || return 1

	config_load network
	config_get_bool enabled "$INTERFACE" clat 1
	config_get_bool passthrough "$INTERFACE" passthrough 0
	[ "$enabled" = 1 ] || return 1

	# A passthrough hands the call to one LAN host, which is where its IPv4
	# would have to be translated; nothing is routed here to translate.
	[ "$passthrough" = 0 ] || return 1

	# nat64 '1' announces the prefix on a call with an IPv4 address too. That
	# address already carries IPv4, and a CLAT would only compete with it.
	[ -f "$IPCFG" ] && . "$IPCFG"
	[ -z "$IPV4_ADDRESS" ]
}

wanted || {
	clat_remove
	exit 0
}

[ "$(cat "$STATE" 2>/dev/null)" = "$PREFIX" ] && exit 0
clat_remove

zone="$(fw4 -q network "$INTERFACE" 2>/dev/null)"

json_init
json_add_string name "$CLAT"
json_add_string ifname "@$INTERFACE"
json_add_string proto 464xlat
json_add_string tunlink "$INTERFACE"
json_add_string ip6prefix "$PREFIX"
[ -n "$zone" ] && json_add_string zone "$zone"
json_close_object

ubus call network add_dynamic "$(json_dump)" || {
	logger -t quectel-clat "could not add $CLAT"
	exit 0
}

mkdir -p "${STATE%/*}"
echo "$PREFIX" >"$STATE"
logger -t quectel-clat "translating IPv4 on $CLAT through $PREFIX"

exit 0
