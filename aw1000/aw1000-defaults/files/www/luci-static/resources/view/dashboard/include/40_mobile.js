'use strict';
'require baseclass';
'require fs';
'require network';
'require view.dashboard.lib.charts as charts';
'require view.dashboard.lib.history as history';

// The AW1000's 5G modem, from what /usr/sbin/aw1000-leds saves while it
// polls the modem for the front panel LEDs. Only that loop talks to the
// modem, so any number of open dashboards cost no AT commands.
const CACHE = '/tmp/aw1000-status/';

// Where the dashboard's samples keep the per-device [ rx, tx ] byte counts.
const NET = 4;

// The charts start at 0, so RSRP is plotted from -140 dBm up and SINR
// from -20 dB up.
const FLOOR = -140, SINR_FLOOR = -20;

// LTE bandwidth, as an index (+QENG) or in resource blocks (+QCAINFO).
const LTE_BW = [ 1.4, 3, 5, 10, 15, 20 ];
const LTE_RB = { 6: 1.4, 15: 3, 25: 5, 50: 10, 75: 15, 100: 20 };
const NR_BW = [ 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 200, 400 ];

// "+NAME: a,"b",c" lines of an AT reply, as { name: [ [ a, b, c ], ... ] }.
function parse(text) {
	const out = {};

	(text || '').split('\n').forEach(line => {
		const m = line.match(/^\s*\+?([A-Z]+): ?(.*)$/);

		if (m)
			(out[m[1]] = out[m[1]] || []).push(m[2].split(',').map(f => f.replace(/"/g, '').trim()));
	});

	return out;
}

function num(v) {
	return (v != null && /^-?\d+(\.\d+)?$/.test(v)) ? +v : null;
}

function bands(list) {
	return list ? list.split(':').join(', ') : '-';
}

// The serving cell, as +QENG reports it in LTE, EN-DC (NSA) or SA mode.
function servingCell(qeng) {
	const cell = { state: null, mode: null, lte: null, nr: null };

	(qeng || []).forEach(f => {
		if (f[0] == 'servingcell') {
			cell.state = f[1];

			if (f[2] == 'LTE') {
				cell.mode = 'LTE';
				cell.lte = { mcc: f[4], mnc: f[5], cid: f[6], pci: f[7], arfcn: f[8], band: 'B' + f[9],
					bw: LTE_BW[num(f[11])], tac: f[12], rsrp: num(f[13]), rsrq: num(f[14]), rssi: num(f[15]), sinr: num(f[16]) };
			}
			else if (f[2] == 'NR5G-SA') {
				cell.mode = 'SA';
				cell.nr = { mcc: f[4], mnc: f[5], cid: f[6], pci: f[7], tac: f[8], arfcn: f[9], band: 'n' + f[10],
					bw: NR_BW[num(f[11])], rsrp: num(f[12]), rsrq: num(f[13]), sinr: num(f[14]) };
			}
		}
		else if (f[0] == 'LTE') {
			cell.mode = 'LTE';
			cell.lte = { mcc: f[2], mnc: f[3], cid: f[4], pci: f[5], arfcn: f[6], band: 'B' + f[7],
				bw: LTE_BW[num(f[9])], tac: f[10], rsrp: num(f[11]), rsrq: num(f[12]), rssi: num(f[13]), sinr: num(f[14]) };
		}
		else if (f[0] == 'NR5G-NSA' && num(f[4]) != null) {
			cell.nr = { pci: f[3], rsrp: num(f[4]), sinr: num(f[5]), rsrq: num(f[6]), arfcn: f[7], band: 'n' + f[8], bw: NR_BW[num(f[9])] };
		}
	});

	if (cell.state == 'SEARCH' || cell.state == 'LIMSRV')
		cell.mode = null;
	else if (cell.mode == 'LTE' && cell.nr)
		cell.mode = 'NSA';

	return cell;
}

// Good, fair and poor from the lowest value of each. RSRP uses the same
// thresholds as the signal and 5G LEDs; RSRQ and SINR the usual LTE/NR ones.
const LEVELS = {
	rsrp: [ -90, -105 ],
	rsrq: [ -10, -15 ],
	sinr: [ 13, 0 ]
};

function quality(kind, v) {
	if (v == null)
		return [ '-', '' ];

	if (v >= LEVELS[kind][0])
		return [ _('Good'), 'success' ];

	if (v >= LEVELS[kind][1])
		return [ _('Fair'), 'notice' ];

	return [ _('Poor'), 'warning' ];
}

function dbm(v, unit) {
	return (v != null) ? '%d %s'.format(v, unit || 'dBm') : '-';
}

function signalBadge(kind, v, unit) {
	const q = quality(kind, v);

	return (v != null) ? E('span', {}, [ charts.badge(dbm(v, unit), q[1]), ' ', q[0] ]) : '-';
}

// The modem throttles itself from about 75 °C (RG500Q).
function tempBadge(t) {
	if (t == null)
		return '-';

	const q = (t >= 75) ? [ _('Hot'), 'danger' ] : (t >= 60) ? [ _('Warm'), 'warning' ] : [ _('Normal'), 'success' ];

	return E('span', {}, [ charts.badge('%d °C'.format(t), q[1]), ' ', q[0] ]);
}

const MODES = { LTE: '4G LTE', NSA: '5G NSA', SA: '5G SA' };

return baseclass.extend({
	title: _('Mobile'),

	widgets: [
		{ id: 'mobile', slot: 'cards', title: _('Mobile'), order: 12 },
		{ id: 'mobile', slot: 'charts', title: _('Mobile signal'), order: 15 },
		{ id: 'mobile-traffic', slot: 'charts', title: _('Mobile traffic'), order: 12 },
		{ id: 'mobile', slot: 'tabs', title: _('Mobile'), order: 15 }
	],

	available() {
		return L.resolveDefault(fs.stat(CACHE + 'live'), null).then(st => st != null);
	},

	load() {
		const read = name => L.resolveDefault(fs.read(CACHE + name), '');

		return Promise.all([ read('live'), read('static'), read('history'), network.getNetworks(), history.load() ]);
	},

	// The modem's interfaces, wwan and the ones its proto adds (wwan_6...).
	uplinks(nets) {
		return nets.filter(net => net.getProtocol() == 'quectel' || /^wwan_/.test(net.getName()));
	},

	renderCard(cell, live, wwan) {
		const op = live.QSPN ? live.QSPN[0][0] : null;
		const main = (cell.mode == 'SA') ? cell.nr : cell.lte;
		const leg = cell.nr && cell.mode == 'NSA' ? cell.lte.band + ' + ' + cell.nr.band : (main ? main.band : null);
		const up = wwan.some(net => net.isUp());

		return charts.kpi({
			icon: 'mobile',
			title: _('Mobile'),
			value: [ cell.mode ? MODES[cell.mode] : _('No service') ],
			sub: cell.mode ? [ op, leg, main ? dbm(main.rsrp) : null, up ? _('Connected') : _('Standby') ] : [ up ? _('Connected') : _('Standby') ]
		});
	},

	renderChart(history) {
		const points = history.split('\n').map(line => line.split(' ')).filter(f => f.length >= 4).map(f => ({
			t: +f[0] * 1000, lte: num(f[2]), nr: num(f[3]), lsinr: num(f[4]), nsinr: num(f[5])
		}));
		const series = (key, floor) => points.map(p => ({ t: p.t, v: (p[key] != null) ? Math.max(0, p[key] - floor) : null }));
		const last = key => points.length ? points[points.length - 1][key] : null;
		const span = points.length > 1 ? Math.max(60, (points[points.length - 1].t - points[0].t) / 1000) : 300;

		// Two plots share the card, so each is lower than a chart of its own.
		const low = (node, height) => {
			node.style.setProperty('--dashboard-plot-h', height);
			return node;
		};

		return charts.card({
			title: _('Mobile signal'),
			desc: _('RSRP · dBm, SINR · dB'),
			body: points.length ? [
				low(charts.lines({
					span: span,
					max: 100,
					ticks: [ -130, -110, -90, -70, -50 ].map(v => ({ value: v - FLOOR, label: String(v) })),
					ariaLabel: _('RSRP'),
					series: [ { values: series('lte', FLOOR), area: true }, { values: series('nr', FLOOR) } ]
				}), '110px'),
				charts.legend([
					{ className: 'dashboard-series-1', label: _('LTE RSRP'), value: dbm(last('lte')) },
					{ className: 'dashboard-series-2', label: _('5G RSRP'), value: dbm(last('nr')) }
				]),
				E('div', { 'style': 'margin-top:12px' }, [
					low(charts.lines({
						span: span,
						max: 50,
						ticks: [ -10, 0, 10, 20, 30 ].map(v => ({ value: v - SINR_FLOOR, label: String(v) })),
						ariaLabel: _('SINR'),
						series: [ { values: series('lsinr', SINR_FLOOR), area: true }, { values: series('nsinr', SINR_FLOOR) } ]
					}), '80px')
				]),
				charts.legend([
					{ className: 'dashboard-series-1', label: _('LTE SINR'), value: dbm(last('lsinr'), 'dB') },
					{ className: 'dashboard-series-2', label: _('5G SINR'), value: dbm(last('nsinr'), 'dB') }
				])
			] : charts.empty(_('Collecting data...'))
		});
	},

	// Rates over all of the modem's QMAP devices (wwan0_1 for IPv4, wwan0_2
	// for IPv6 on its own PDN), from the same samples as the WAN chart. The
	// counters include NSS-offloaded traffic. A device whose counters went
	// backwards, as after an ifup, leaves a gap.
	rates(index) {
		return history.series((cur, prev, seconds) => {
			if (prev == null)
				return null;

			let sum = null;

			for (const name in cur[NET]) {
				if (!/^wwan0(_\d+)?$/.test(name) || prev[NET][name] == null)
					continue;

				const a = prev[NET][name], b = cur[NET][name];

				if (b[0] < a[0] || b[1] < a[1])
					return null;

				sum = (sum || 0) + (b[index] - a[index]) * 8 / seconds;
			}

			return sum;
		});
	},

	renderTraffic(wwan) {
		const up = wwan.some(net => net.isUp());
		const down = this.rates(0);
		const upl = this.rates(1);
		const last = points => points.length ? points[points.length - 1].v : null;
		const scale = charts.rateScale(Math.max(1, ...down.concat(upl).map(p => p.v || 0)));
		const devs = wwan.filter(net => net.isUp()).map(net => net.getL3Device()).filter(dev => dev).map(dev => dev.getName());

		return charts.card({
			title: _('Mobile traffic'),
			desc: [ ...new Set([ 'wwan', ...devs ]) ].join(' · ') + ' · ' + scale.unit,
			body: down.length ? [
				charts.lines({
					span: history.span(),
					max: scale.max,
					ticks: scale.ticks,
					ariaLabel: _('Mobile traffic'),
					series: [ { values: down, area: true }, { values: upl, area: true } ]
				}),
				charts.legend([
					{ className: 'dashboard-series-1', label: _('Down.'), value: charts.formatRate(last(down)) },
					{ className: 'dashboard-series-2', label: _('Up.'), value: charts.formatRate(last(upl)) }
				]),
				up ? '' : E('small', {}, [ _('Standby (wwan down)') ])
			] : charts.empty(history.status())
		});
	},

	renderTab(cell, live, stat, wwan) {
		const carriers = [];
		const head = [ _('Carrier'), _('Band'), _('Bandwidth'), _('PCI'), _('ARFCN'), _('RSRP'), _('RSRQ'), _('SINR') ];
		const row = (role, c) => [ role, c.band, c.bw ? '%s MHz'.format(c.bw) : '-', c.pci || '-', c.arfcn || '-',
			signalBadge('rsrp', c.rsrp), signalBadge('rsrq', c.rsrq, 'dB'), signalBadge('sinr', c.sinr, 'dB') ];

		if (cell.lte)
			carriers.push(row(cell.mode == 'NSA' ? _('LTE anchor') : _('LTE primary'), cell.lte));

		// Secondary LTE carriers; the NR leg is in +QENG already.
		(live.QCAINFO || []).filter(f => f[0] == 'SCC' && /^LTE/.test(f[3])).forEach(f => {
			carriers.push(row(_('LTE secondary'), { band: f[3].replace(/^LTE BAND /, 'B'), bw: LTE_RB[num(f[2])], arfcn: f[1],
				pci: f[5], rsrp: num(f[6]), rsrq: num(f[7]), sinr: num(f[9]) }));
		});

		if (cell.nr)
			carriers.push(row(cell.mode == 'SA' ? _('NR primary') : _('NR (EN-DC)'), cell.nr));

		const first = (name, key) => {
			const list = stat[name] || [];
			const hit = key ? list.find(f => f[0] == key) : list[0];

			return hit ? hit.slice(key ? 1 : 0) : null;
		};
		const lock = key => {
			const f = first('QNWLOCK', key);

			return (!f || f[0] == '0' || f[0] == '') ? _('Not locked') : f.join(', ');
		};
		const temps = (live.QTEMP || []).map(f => num(f[1])).filter(v => v != null);
		const main = (cell.mode == 'SA') ? cell.nr : cell.lte;
		const cid = main && main.cid ? parseInt(main.cid, 16) : NaN;
		const addrs = [];

		wwan.filter(net => net.isUp()).forEach(net => {
			addrs.push(...net.getIPAddrs(), ...net.getIP6Addrs());
		});

		const up = wwan.find(net => net.getName() == 'wwan' && net.isUp());
		const pdp = (stat.CGCONTRDP || [])[0];
		const fw = (stat._text || '').split('\n').map(l => l.trim()).find(l => /^RG\w+$/.test(l));
		const info = [
			[ _('Operator'), live.QSPN ? '%s (%s)'.format(live.QSPN[0][0], live.QSPN[0][4]) : '-' ],
			[ _('Technology'), cell.mode ? MODES[cell.mode] : _('No service') ],
			[ _('Connection'), up ? E('span', {}, [ charts.badge(_('Connected'), 'success'), ' ', '%t'.format(up.getUptime()) ])
				: cell.mode ? E('span', {}, [ charts.badge(_('Standby'), 'warning'), ' ', _('wwan down') ])
				: E('span', {}, [ charts.badge(_('No service'), 'danger'), ' ', _('wwan down') ]) ],
			[ _('Addresses'), addrs.length ? E('span', {}, addrs.flatMap((a, i) => i ? [ E('br'), a ] : [ a ])) : '-' ],
			[ _('APN'), pdp ? pdp[2] : '-' ],
			[ _('Cell ID'), isNaN(cid) ? '-' : (cell.mode == 'SA' ? '%s (%d)'.format(main.cid, cid)
				: _('%s (eNB %d, cell %d)').format(main.cid, cid >> 8, cid & 255)) ],
			[ _('TAC'), main && main.tac ? '%s (%d)'.format(main.tac, parseInt(main.tac, 16)) : '-' ],
			[ _('Network mode'), (first('QNWPREFCFG', 'mode_pref') || [ '-' ])[0].replace(':', ' + ') ],
			[ _('LTE bands'), bands((first('QNWPREFCFG', 'lte_band') || [])[0]) ],
			[ _('5G NSA bands'), bands((first('QNWPREFCFG', 'nsa_nr5g_band') || [])[0]) ],
			[ _('5G SA bands'), bands((first('QNWPREFCFG', 'nr5g_band') || [])[0]) ],
			[ _('LTE cell lock'), lock('common/4g') ],
			[ _('5G cell lock'), lock('common/5g') ],
			[ _('SIM'), (stat.QUIMSLOT ? _('Slot %s').format(stat.QUIMSLOT[0][0]) + ' · ' : '') + (stat.QCCID ? stat.QCCID[0][0] : '-') ],
			[ _('Firmware'), fw || '-' ],
			[ _('Temperature'), tempBadge(temps.length ? Math.max(...temps) : null) ]
		];

		return E('div', {}, [
			charts.table({ head: head, rows: carriers, emptyText: _('No serving cell') }),
			E('table', { 'class': 'table' }, info.map(r => E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': '33%' }, [ r[0] ]),
				E('td', { 'class': 'td left' }, [ r[1] ])
			]))),
			E('p', {}, [ E('a', { 'href': L.url('admin/modem/luci-app-modemband') }, [ _('Preferred LTE/5G bands') ]) ])
		]);
	},

	render([ liveText, statText, signal, nets ]) {
		const live = parse(liveText);
		const stat = Object.assign(parse(statText), { _text: statText });
		const cell = servingCell(live.QENG);
		const wwan = this.uplinks(nets);

		return {
			cards: [ { id: 'mobile', node: () => this.renderCard(cell, live, wwan) } ],
			charts: [
				{ id: 'mobile', node: () => this.renderChart(signal) },
				{ id: 'mobile-traffic', node: () => this.renderTraffic(wwan) }
			],
			tabs: [ { id: 'mobile', title: _('Mobile'), content: () => this.renderTab(cell, live, stat, wwan) } ]
		};
	}
});
