'use strict';
'require baseclass';

// The RG500Q's AT replies, read for the dashboard's mobile widgets and the
// modem pages: serving cell, band names, signal quality and a bars icon.

// LTE bandwidth, as an index (+QENG) or in resource blocks (+QCAINFO, +QSCAN).
const LTE_BW = [ 1.4, 3, 5, 10, 15, 20 ];
const LTE_RB = { 6: 1.4, 15: 3, 25: 5, 50: 10, 75: 15, 100: 20 };
const NR_BW = [ 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 200, 400 ];

// Downlink frequency (MHz) and duplex of the bands the RG500Q-EA supports.
const LTE_BANDS = {
	1: '2100', 3: '1800', 5: '850', 7: '2600', 8: '900', 18: '850', 19: '850', 20: '800',
	26: '850', 28: '700', 32: '1500 SDL', 34: '2000 TDD', 38: '2600 TDD', 39: '1900 TDD',
	40: '2300 TDD', 41: '2500 TDD', 42: '3500 TDD', 43: '3700 TDD'
};
const NR_BANDS = {
	1: '2100', 3: '1800', 5: '850', 7: '2600', 8: '900', 20: '800', 28: '700', 38: '2600 TDD',
	40: '2300 TDD', 41: '2500 TDD', 77: '3700 TDD', 78: '3500 TDD', 79: '4700 TDD'
};

// The band of an LTE downlink EARFCN (3GPP TS 36.101 table 5.7.3-1).
const EARFCN = [
	[ 1, 0, 599 ], [ 3, 1200, 1949 ], [ 5, 2400, 2649 ], [ 7, 2750, 3449 ], [ 8, 3450, 3799 ],
	[ 18, 5850, 5999 ], [ 19, 6000, 6149 ], [ 20, 6150, 6449 ], [ 26, 8690, 9039 ],
	[ 28, 9210, 9659 ], [ 32, 9920, 10359 ], [ 34, 36200, 36349 ], [ 38, 37750, 38249 ],
	[ 39, 38250, 38649 ], [ 40, 38650, 39649 ], [ 41, 39650, 41589 ], [ 42, 41590, 43589 ],
	[ 43, 43590, 45589 ]
];

// Good, fair and poor from the lowest value of each. RSRP uses the same
// thresholds as the signal and 5G LEDs; RSRQ and SINR the usual LTE/NR ones.
const LEVELS = {
	rsrp: [ -90, -105 ],
	rsrq: [ -10, -15 ],
	rssi: [ -75, -85 ],
	sinr: [ 13, 0 ],
	csq: [ 20, 14 ]
};

// One bar per threshold reached; the RSRP ones match the levels above.
const SVG_NS = 'http://www.w3.org/2000/svg';
const BARS = { rsrp: [ -115, -105, -90, -80 ], csq: [ 10, 14, 20, 25 ] };
const TONE = {
	success: 'var(--fs-good, #2e9d4f)',
	notice: 'var(--fs-accent, #2f7fc4)',
	warning: 'var(--fs-warn, #d4881a)'
};

// Line icons on a 24 px grid, drawn in the text colour.
const ICONS = {
	lock: [ 'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z', 'M8 11V7a4 4 0 0 1 8 0v4' ],
	unlock: [ 'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z', 'M8 11V7a4 4 0 0 1 7.7-1.5' ],
	tower: [ 'M12 12v9', 'M9 21h6', 'M8.5 8.5a5 5 0 0 0 0 7', 'M15.5 8.5a5 5 0 0 1 0 7', 'M5.6 5.6a9 9 0 0 0 0 12.8',
		'M18.4 5.6a9 9 0 0 1 0 12.8', 'M12 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2z' ],
	sliders: [ 'M4 6h9', 'M17 6h3', 'M15 4v4', 'M4 12h3', 'M11 12h9', 'M9 10v4', 'M4 18h11', 'M19 18h1', 'M17 16v4' ],
	chat: [ 'M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z' ],
	send: [ 'M21 3 10 14', 'M21 3l-7 18-4-7-7-4z' ],
	trash: [ 'M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6' ],
	plus: [ 'M12 5v14', 'M5 12h14' ],
	back: [ 'M15 18l-6-6 6-6' ],
	refresh: [ 'M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v5h-5' ],
	radar: [ 'M12 3a9 9 0 1 0 9 9', 'M12 7a5 5 0 1 0 5 5', 'M12 12l7-7' ],
	terminal: [ 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M7 10l3 2-3 2', 'M12 15h5' ],
	search: [ 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'M20 20l-4-4' ]
};

function num(v) {
	return (v != null && /^-?\d+(\.\d+)?$/.test(v)) ? +v : null;
}

return baseclass.extend({
	LTE_BW: LTE_BW,
	LTE_RB: LTE_RB,
	NR_BW: NR_BW,
	LTE_BANDS: LTE_BANDS,
	NR_BANDS: NR_BANDS,
	LEVELS: LEVELS,
	MODES: { LTE: '4G LTE', NSA: '5G NSA', SA: '5G SA' },

	num: num,

	// "+NAME: a,"b",c" lines of an AT reply, as { name: [ [ a, b, c ], ... ] }.
	parse(text) {
		const out = {};

		(text || '').split('\n').forEach(line => {
			const m = line.match(/^\s*\+?([A-Z][A-Z0-9]*): ?(.*)$/);

			if (m)
				(out[m[1]] = out[m[1]] || []).push(m[2].split(',').map(f => f.replace(/"/g, '').trim()));
		});

		return out;
	},

	lteBand(earfcn) {
		const e = num(earfcn);
		const hit = (e != null) ? EARFCN.find(r => e >= r[1] && e <= r[2]) : null;

		return hit ? hit[0] : null;
	},

	// "B3 1800" or "n41 2500 TDD", for a band number of an RAT.
	bandName(rat, band) {
		const nr = (rat == 'NR');
		const mhz = (nr ? NR_BANDS : LTE_BANDS)[band];

		return (nr ? 'n' : 'B') + band + (mhz ? ' · ' + mhz : '');
	},

	// The serving cell, as +QENG reports it in LTE, EN-DC (NSA) or SA mode.
	servingCell(qeng) {
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
	},

	// [ label, badge class ] of a reading.
	quality(kind, v) {
		if (v == null)
			return [ '-', '' ];

		if (v >= LEVELS[kind][0])
			return [ _('Good'), 'success' ];

		if (v >= LEVELS[kind][1])
			return [ _('Fair'), 'notice' ];

		return [ _('Poor'), 'warning' ];
	},

	dbm(v, unit) {
		return (v != null) ? '%d %s'.format(v, unit || 'dBm') : '-';
	},

	// A four-bar signal icon in the colour of the reading's badge (Footstrap's
	// variables, fixed colours in other themes); the bars not reached are faint.
	bars(kind, v) {
		const n = (v != null) ? BARS[kind].filter(t => v >= t).length : 0;
		const tone = TONE[this.quality(kind, v)[1]] || 'currentColor';
		const svg = document.createElementNS(SVG_NS, 'svg');

		svg.setAttribute('viewBox', '0 0 19 16');
		svg.setAttribute('width', '1.2em');
		svg.setAttribute('height', '1em');
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', _('%d of 4 bars').format(n));
		svg.style.verticalAlign = '-0.1em';

		for (let i = 0; i < 4; i++) {
			const bar = document.createElementNS(SVG_NS, 'rect');
			const h = 4 * (i + 1);

			bar.setAttribute('x', 5 * i);
			bar.setAttribute('y', 16 - h);
			bar.setAttribute('width', 3.5);
			bar.setAttribute('height', h);
			bar.setAttribute('rx', 0.8);
			// A style, not the fill attribute: attributes do not take var().
			bar.style.fill = (i < n) ? tone : 'currentColor';

			if (i >= n)
				bar.style.fillOpacity = 0.2;

			svg.appendChild(bar);
		}

		return svg;
	},

	// An icon of ICONS, 1em unless a size is given.
	icon(name, size) {
		const svg = document.createElementNS(SVG_NS, 'svg');

		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('width', size || '1em');
		svg.setAttribute('height', size || '1em');
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '2');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		svg.style.verticalAlign = '-0.125em';

		(ICONS[name] || []).forEach(d => {
			const path = document.createElementNS(SVG_NS, 'path');

			path.setAttribute('d', d);
			svg.appendChild(path);
		});

		return svg;
	},

	// The cell lock of +QNWLOCK, "common/4g" ("<n>,<earfcn>,<pci>,...") or
	// "common/5g" ("<pci>,<arfcn>,<scs>,<band>", SA only), as text; null
	// when not locked.
	lockText(key, f) {
		if (!f || f[0] == '0' || f[0] == '')
			return null;

		if (key == 'common/5g')
			return _('n%s · ARFCN %s, PCI %s').format(f[3], f[1], f[0]);

		const cells = [];

		for (let i = 1; i + 1 < f.length && cells.length < num(f[0]); i += 2) {
			const band = this.lteBand(f[i]);

			cells.push(_('%sEARFCN %s, PCI %s').format(band ? 'B%d · '.format(band) : '', f[i], f[i + 1]));
		}

		return cells.join('; ');
	},

	// Bars (RSRP and CSQ), the value as a badge and its quality.
	signal(kind, v, unit) {
		const q = this.quality(kind, v);

		if (v == null)
			return '-';

		// Flat: a nested array in E() ends up as text.
		return E('span', { 'style': 'white-space:nowrap' }, (BARS[kind] ? [ this.bars(kind, v), ' ' ] : [])
			.concat([ E('span', { 'class': 'label ' + q[1] }, [ this.dbm(v, unit) ]), ' ', q[0] ]));
	}
});
