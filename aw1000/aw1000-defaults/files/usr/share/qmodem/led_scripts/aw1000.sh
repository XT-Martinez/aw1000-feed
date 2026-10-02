#!/bin/sh
# Arcadyan AW1000 front panel, driven as a QModem modem_status LED script.
#
#   signal (RGB)  serving cell RSRP: green >= -90, blue >= -105, red below,
#                 off without service
#   5g (RGB)      green on NR (SA or EN-DC), blue on LTE only, red while
#                 registered without a data call, off without service
#   phone         blinks while QModem holds unread received SMS
#
# Called by /etc/init.d/qmodem_led as "aw1000.sh <modem section> [off]".

. /lib/functions.sh

MODEM_CFG="$1"
ON_OFF="$2"

POLL=10
SMS_EVERY=3

LED_SIG_R="red:signal"
LED_SIG_G="green:signal"
LED_SIG_B="blue:signal"
LED_5G_R="red:5g"
LED_5G_G="green:5g"
LED_5G_B="blue:5g"
LED_PHONE="green:phone"

led_set() {
	local path="/sys/class/leds/$1"

	[ -d "$path" ] || return
	echo none >"$path/trigger"
	if [ "$2" = 1 ]; then
		cat "$path/max_brightness" >"$path/brightness"
	else
		echo 0 >"$path/brightness"
	fi
}

led_blink() {
	local path="/sys/class/leds/$1"

	[ -d "$path" ] || return
	grep -q '\[timer\]' "$path/trigger" && return
	echo timer >"$path/trigger"
	echo 500 >"$path/delay_on"
	echo 1500 >"$path/delay_off"
}

# rgb <red> <green> <blue> <r> <g> <b>
rgb() {
	led_set "$1" "$4"
	led_set "$2" "$5"
	led_set "$3" "$6"
}

all_off() {
	rgb "$LED_SIG_R" "$LED_SIG_G" "$LED_SIG_B" 0 0 0
	rgb "$LED_5G_R" "$LED_5G_G" "$LED_5G_B" 0 0 0
	led_set "$LED_PHONE" 0
}

# The first entry is the serving cell: the LTE anchor on EN-DC.
cell_value() {
	echo "$cell" | jq -r --arg k "$1" \
		'[.modem_info[]? | select(.key == $k) | .value] | first // empty' 2>/dev/null
}

has_data_call() {
	local dev

	for dev in /sys/class/net/wwan*; do
		dev="${dev##*/}"
		[ "$dev" = 'wwan*' ] && return 1
		ip -4 addr show dev "$dev" 2>/dev/null | grep -q 'inet ' && return 0
		ip -6 addr show dev "$dev" scope global 2>/dev/null | grep -q 'inet6 ' && return 0
	done
	return 1
}

update_signal_and_mode() {
	local mode rsrp

	cell="$(ubus -t 30 call qmodem cell_info "{\"config_section\":\"$MODEM_CFG\"}" 2>/dev/null)"
	mode="$(cell_value network_mode)"
	rsrp="$(cell_value RSRP)"
	rsrp="${rsrp%%.*}"

	case "$rsrp" in
	'' | null | *[!0-9-]*)
		rgb "$LED_SIG_R" "$LED_SIG_G" "$LED_SIG_B" 0 0 0
		rgb "$LED_5G_R" "$LED_5G_G" "$LED_5G_B" 0 0 0
		return
		;;
	esac

	if [ "$rsrp" -ge -90 ]; then
		rgb "$LED_SIG_R" "$LED_SIG_G" "$LED_SIG_B" 0 1 0
	elif [ "$rsrp" -ge -105 ]; then
		rgb "$LED_SIG_R" "$LED_SIG_G" "$LED_SIG_B" 0 0 1
	else
		rgb "$LED_SIG_R" "$LED_SIG_G" "$LED_SIG_B" 1 0 0
	fi

	if ! has_data_call; then
		rgb "$LED_5G_R" "$LED_5G_G" "$LED_5G_B" 1 0 0
		return
	fi

	case "$mode" in
	*NR5G* | *EN-DC* | *NR*) rgb "$LED_5G_R" "$LED_5G_G" "$LED_5G_B" 0 1 0 ;;
	*) rgb "$LED_5G_R" "$LED_5G_G" "$LED_5G_B" 0 0 1 ;;
	esac
}

update_sms() {
	local unread

	unread="$(ubus -t 10 call qmodem.sms list "{\"modem_id\":\"$MODEM_CFG\",\"limit\":200}" 2>/dev/null |
		jq '[.messages[]? | select(.type == "received" and (.is_read == false or .is_read == 0))] | length' 2>/dev/null)"

	if [ "${unread:-0}" -gt 0 ] 2>/dev/null; then
		led_blink "$LED_PHONE"
	else
		led_set "$LED_PHONE" 0
	fi
}

if [ "$ON_OFF" = off ]; then
	all_off
	exit 0
fi

trap 'all_off; exit 0' INT TERM

tick=0
while :; do
	update_signal_and_mode
	[ $((tick % SMS_EVERY)) -eq 0 ] && update_sms
	tick=$((tick + 1))
	sleep "$POLL"
done
