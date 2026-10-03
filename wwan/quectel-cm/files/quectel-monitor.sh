#!/bin/sh
# shellcheck shell=busybox disable=1091,3043
#
# Watches a data call and has netifd rebuild the interface when it changes or
# stops carrying traffic. This runs as the proto task of the interface, so
# netifd tears the interface down and brings it up again by itself once this
# exits.
#
# A call that quectel-cm re-establishes with new settings (a cell lock, a
# reattach) is rebuilt rather than updated in place: on the RG500Q with QMAP the
# modem then delivered nothing more on the channel (rx stayed at 0 while tx
# went on) until quectel-cm, the call and the netdev were set up again.

. /lib/functions.sh
. /lib/netifd/netifd-proto.sh
INCLUDE_ONLY=1 . /lib/netifd/proto/quectel.sh

interface="$1"
ifname="$2"
ipcfg="$3"
cm_pid="$4"
grace="$5"
defaultroute="$6"
peerdns="$7"
sourcefilter="$8"
prefixlifetime="$9"
# ${10} onwards, not $10: that is $1 followed by a literal zero.
passthrough="${10}"
device="${11}"
nat64="${12}"
nat64prefix="${13}"

# Downlink watchdog: once nothing has come in for STALL seconds, ping out of the
# interface. If that goes out (tx grows) and nothing answers, the channel is
# dead. Without a route out of it the ping does not leave and nothing happens.
STALL=60
PROBE_HOSTS="1.1.1.1 8.8.8.8 9.9.9.9"
stats="/sys/class/net/$ifname/statistics"

seen="$(cat "$ipcfg" 2>/dev/null)"
lost=0
rx_last="$(cat "$stats/rx_packets" 2>/dev/null)"
tx_at="$(cat "$stats/tx_packets" 2>/dev/null)"
quiet=0

while :; do
	# A handover replaces the settings in well under a second, so poll tightly
	# enough that the window in which netifd still holds the previous address
	# stays short.
	sleep 2

	[ -d "/proc/$cm_pid" ] || {
		echo "quectel-cm for $interface is gone"
		exit 1
	}

	# quectel-cm survives some resets on its own, waiting for the modem to come
	# back and dialling again, so the grace period below is what a reset would
	# otherwise cost before netifd rebuilds the interface. The control device
	# leaving the bus is not a data call that might return in a moment - it is the
	# whole modem gone - so hand it straight back to netifd instead.
	[ -z "$device" ] || [ -c "$device" ] || {
		echo "The control device of $interface is gone"
		exit 1
	}

	current="$(cat "$ipcfg" 2>/dev/null)"

	[ -n "$current" ] || {
		# A dropped data call normally comes back within seconds, and sitting it
		# out is far cheaper than having netifd rebuild the interface and the
		# modem session, so only give up once it stays away.
		lost=$((lost + 2))
		[ "$lost" -lt "$grace" ] && continue

		echo "The data call of $interface stayed down for ${lost}s"
		exit 1
	}

	lost=0

	[ "$current" = "$seen" ] || {
		echo "The data call of $interface came back with new settings, setting it up again"
		exit 1
	}

	rx="$(cat "$stats/rx_packets" 2>/dev/null)"
	tx="$(cat "$stats/tx_packets" 2>/dev/null)"
	[ -n "$rx" ] && [ -n "$tx" ] || continue
	if [ "$rx" != "$rx_last" ]; then
		rx_last="$rx"
		tx_at="$tx"
		quiet=0
		continue
	fi
	quiet=$((quiet + 2))
	[ "$quiet" -lt "$STALL" ] && continue

	quiet=0
	for h in $PROBE_HOSTS; do
		ping -q -c 2 -W 2 -I "$ifname" "$h" >/dev/null 2>&1 && continue 2
	done
	tx="$(cat "$stats/tx_packets" 2>/dev/null)"
	rx="$(cat "$stats/rx_packets" 2>/dev/null)"
	[ "$rx" = "$rx_last" ] && [ $((tx - tx_at)) -ge 3 ] && {
		echo "$ifname sent $((tx - tx_at)) packets and received none, setting $interface up again"
		exit 1
	}
	rx_last="$rx"
	tx_at="$tx"
done
