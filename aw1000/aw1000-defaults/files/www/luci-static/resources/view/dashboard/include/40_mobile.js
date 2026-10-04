'use strict';
'require baseclass';
'require fs';
'require network';
'require view.dashboard.lib.charts as charts';
'require view.dashboard.lib.history as history';
'require aw1000.mcc as mcc';
'require aw1000.cell as rf';

// The AW1000's 5G modem, from what /usr/sbin/aw1000-leds saves while it
// polls the modem for the front panel LEDs. Only that loop talks to the
// modem, so any number of open dashboards cost no AT commands.
const CACHE = '/tmp/aw1000-status/';

// Where the dashboard's samples keep the per-device [ rx, tx ] byte counts.
const NET = 4;

// The charts start at 0, so RSRP is plotted from -140 dBm up and SINR
// from -20 dB up.
const FLOOR = -140, SINR_FLOOR = -20;

// The data connections in +CGCONTRDP, one line per bearer: "<cid>,<bearer>,
// <apn>,<address>,...". The address tells the family: an IPv6 one has colons
// or, in Quectel's default notation, 16 dotted numbers.
function apns(lines) {
	const seen = {};

	(lines || []).forEach(f => {
		const addr = f[3] || '';
		const fam = (addr.includes(':') || addr.split('.').length >= 16) ? 'IPv6' : (addr ? 'IPv4' : null);

		if (f[2]) {
			seen[f[2]] = seen[f[2]] || [];

			if (fam && !seen[f[2]].includes(fam))
				seen[f[2]].push(fam);
		}
	});

	return Object.keys(seen).map(apn => seen[apn].length ? '%s (%s)'.format(apn, seen[apn].join(', ')) : apn).join(' · ') || '-';
}

function bands(list) {
	return list ? list.split(':').join(', ') : '-';
}

// AT+CSQ: 0-31 is -113 dBm and up in 2 dB steps, 99 not known. The
// percentage is the CSQ's share of 31, as luci-app-modemdata shows it.
function csqBadge(csq) {
	if (csq == null || csq < 0 || csq > 31)
		return '-';

	const q = rf.quality('csq', csq);

	return E('span', {}, [ rf.bars('csq', csq), ' ', charts.badge('%d%%'.format(Math.floor(csq * 100 / 31)), q[1]), ' ',
		_('CSQ %d, %d dBm').format(csq, -113 + 2 * csq) ]);
}

// +CEREG (LTE, also NSA) and +C5GREG (SA) "<n>,<stat>", whichever is
// registered.
const REG = {
	0: [ _('Not registered'), 'danger' ],
	1: [ _('Home network'), 'success' ],
	2: [ _('Searching'), 'warning' ],
	3: [ _('Denied'), 'danger' ],
	4: [ _('Unknown'), 'warning' ],
	5: [ _('Roaming'), 'notice' ]
};

function registration(live) {
	const stat = name => live[name] ? rf.num(live[name][0][1]) : null;
	const lte = stat('CEREG'), nr = stat('C5GREG');
	const r = REG[(nr == 1 || nr == 5) ? nr : lte];

	return r ? charts.badge(r[0], r[1]) : '-';
}

// The modem throttles itself from about 75 °C (RG500Q).
function tempBadge(t) {
	if (t == null)
		return '-';

	const q = (t >= 75) ? [ _('Hot'), 'danger' ] : (t >= 60) ? [ _('Warm'), 'warning' ] : [ _('Normal'), 'success' ];

	return E('span', { 'class': 'label ' + q[1], 'title': q[0] }, [ '%d °C'.format(t) ]);
}

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
			value: cell.mode ? [ rf.bars('rsrp', main ? main.rsrp : null), ' ', rf.MODES[cell.mode] ] : [ _('No service') ],
			sub: cell.mode ? [ op, leg, main ? rf.dbm(main.rsrp) : null, up ? _('Connected') : _('Standby') ] : [ up ? _('Connected') : _('Standby') ]
		});
	},

	renderChart(history) {
		const points = history.split('\n').map(line => line.split(' ')).filter(f => f.length >= 4).map(f => ({
			t: +f[0] * 1000, lte: rf.num(f[2]), nr: rf.num(f[3]), lsinr: rf.num(f[4]), nsinr: rf.num(f[5])
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
					{ className: 'dashboard-series-1', label: _('LTE RSRP'), value: rf.dbm(last('lte')) },
					{ className: 'dashboard-series-2', label: _('5G RSRP'), value: rf.dbm(last('nr')) }
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
					{ className: 'dashboard-series-1', label: _('LTE SINR'), value: rf.dbm(last('lsinr'), 'dB') },
					{ className: 'dashboard-series-2', label: _('5G SINR'), value: rf.dbm(last('nsinr'), 'dB') }
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
		const head = [ _('Carrier'), _('Band'), _('Bandwidth'), _('PCI / ARFCN'), _('RSRP'), _('RSRQ'), _('RSSI'), _('SINR') ];
		const row = (role, c) => [ role, c.band, c.bw ? '%s MHz'.format(c.bw) : '-', '%s / %s'.format(c.pci || '-', c.arfcn || '-'),
			rf.signal('rsrp', c.rsrp), rf.signal('rsrq', c.rsrq, 'dB'), rf.signal('rssi', c.rssi), rf.signal('sinr', c.sinr, 'dB') ];

		if (cell.lte)
			carriers.push(row(cell.mode == 'NSA' ? _('LTE anchor') : _('LTE primary'), cell.lte));

		// Secondary LTE carriers; the NR leg is in +QENG already.
		(live.QCAINFO || []).filter(f => f[0] == 'SCC' && /^LTE/.test(f[3])).forEach(f => {
			carriers.push(row(_('LTE secondary'), { band: f[3].replace(/^LTE BAND /, 'B'), bw: rf.LTE_RB[rf.num(f[2])], arfcn: f[1],
				pci: f[5], rsrp: rf.num(f[6]), rsrq: rf.num(f[7]), rssi: rf.num(f[8]), sinr: rf.num(f[9]) }));
		});

		if (cell.nr)
			carriers.push(row(cell.mode == 'SA' ? _('NR primary') : _('NR (EN-DC)'), cell.nr));

		const first = (name, key) => {
			const list = stat[name] || [];
			const hit = key ? list.find(f => f[0] == key) : list[0];

			return hit ? hit.slice(key ? 1 : 0) : null;
		};
		// The lock, linked with its icon to the cell lock page.
		const lock = key => {
			const text = rf.lockText(key, first('QNWLOCK', key));

			return E('a', { 'href': L.url('admin/modem/cells'), 'title': _('Cell lock and scan') }, [
				rf.icon(text ? 'lock' : 'unlock'), ' ', text || _('Not locked')
			]);
		};
		const temps = (live.QTEMP || []).map(f => rf.num(f[1])).filter(v => v != null);
		const main = (cell.mode == 'SA') ? cell.nr : cell.lte;
		const cid = main && main.cid ? parseInt(main.cid, 16) : NaN;
		const addrs = [];

		wwan.filter(net => net.isUp()).forEach(net => {
			addrs.push(...net.getIPAddrs(), ...net.getIP6Addrs());
		});

		const up = wwan.find(net => net.getName() == 'wwan' && net.isUp());
		// +CGMI, +CGMM and +CGMR answer without a prefix: maker, model, firmware.
		const plain = (stat._text || '').split('\n').map(l => l.trim()).filter(l => l && !/^(OK|ERROR)$/.test(l) && !/[:+]/.test(l));
		const fw = plain.find(l => /^RG\w+$/.test(l));
		const plmn = live.QSPN ? live.QSPN[0][4] : '';
		const country = mcc.country(plmn);
		const info = [
			[ _('Operator'), live.QSPN ? [ live.QSPN[0][0], plmn ? '%s %s'.format(plmn.slice(0, 3), plmn.slice(3)) : null, country ]
				.filter(v => v).join(' · ') : '-' ],
			[ _('Registration'), registration(live) ],
			[ _('Technology'), cell.mode ? rf.MODES[cell.mode] : _('No service') ],
			[ _('Signal strength'), csqBadge(live.CSQ ? rf.num(live.CSQ[0][0]) : null) ],
			[ _('Connection'), up ? E('span', {}, [ charts.badge(_('Connected'), 'success'), ' ', '%t'.format(up.getUptime()) ])
				: cell.mode ? E('span', {}, [ charts.badge(_('Standby'), 'warning'), ' ', _('wwan down') ])
				: E('span', {}, [ charts.badge(_('No service'), 'danger'), ' ', _('wwan down') ]) ],
			[ _('Addresses'), addrs.length ? E('span', {}, addrs.flatMap((a, i) => i ? [ E('br'), a ] : [ a ])) : '-' ],
			[ _('APN'), apns(stat.CGCONTRDP) ],
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
			[ _('Modem'), plain.filter(l => l != fw).join(' ') || '-' ],
			[ _('Firmware'), fw || '-' ],
			[ _('Temperature'), tempBadge(temps.length ? Math.max(...temps) : null) ]
		];

		return E('div', {}, [
			charts.table({ head: head, rows: carriers, emptyText: _('No serving cell') }),
			E('table', { 'class': 'table' }, info.map(r => E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': '33%' }, [ r[0] ]),
				E('td', { 'class': 'td left' }, [ r[1] ])
			]))),
			E('p', {}, [
				E('a', { 'href': L.url('admin/modem/bands') }, [ rf.icon('sliders'), ' ', _('Preferred LTE/5G bands') ]),
				' · ',
				E('a', { 'href': L.url('admin/modem/cells') }, [ rf.icon('tower'), ' ', _('Cell scan and lock') ])
			])
		]);
	},

	render([ liveText, statText, signal, nets ]) {
		const live = rf.parse(liveText);
		const stat = Object.assign(rf.parse(statText), { _text: statText });
		const cell = rf.servingCell(live.QENG);
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
