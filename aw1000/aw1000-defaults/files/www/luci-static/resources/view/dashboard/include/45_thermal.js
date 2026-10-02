'use strict';
'require baseclass';
'require fs';
'require view.dashboard.lib.charts as charts';

// The AW1000's temperatures, as /usr/sbin/aw1000-leds records them every
// poll: the hottest sensor of each group, in °C.
const FILE = '/tmp/aw1000-status/thermal';

// The charts start at 0, so temperatures are plotted from 20 °C up.
const FLOOR = 20;

const GROUPS = [
	{ key: 'cpu', label: _('CPU') },
	{ key: 'nss', label: _('NSS') },
	{ key: 'wifi', label: _('Wi-Fi') },
	{ key: 'modem', label: _('Modem') }
];

function num(v) {
	return (v != null && /^-?\d+$/.test(v)) ? +v : null;
}

function celsius(v) {
	return (v != null) ? '%d °C'.format(v) : '-';
}

return baseclass.extend({
	widgets: [
		{ id: 'thermal', slot: 'cards', title: _('Temperature'), order: 35 },
		{ id: 'thermal', slot: 'charts', title: _('Temperature'), order: 25 }
	],

	available() {
		return L.resolveDefault(fs.stat(FILE), null).then(st => st != null);
	},

	load() {
		return L.resolveDefault(fs.read(FILE), '');
	},

	points(text) {
		return text.split('\n').map(line => line.split(' ')).filter(f => f.length == 5).map(f => ({
			t: +f[0] * 1000, cpu: num(f[1]), nss: num(f[2]), wifi: num(f[3]), modem: num(f[4])
		}));
	},

	renderCard(last) {
		return charts.kpi({
			icon: 'thermal',
			title: _('Temperature'),
			value: [ last ? _('CPU %s').format(celsius(last.cpu)) : '-' ],
			sub: last ? GROUPS.slice(1).map(g => '%s %s'.format(g.label, celsius(last[g.key]))) : []
		});
	},

	renderChart(points) {
		const last = points[points.length - 1];
		const span = points.length > 1 ? Math.max(60, (last.t - points[0].t) / 1000) : 300;

		return charts.card({
			title: _('Temperature'),
			desc: _('hottest sensor · °C'),
			body: points.length ? [
				charts.lines({
					span: span,
					max: 80,
					ticks: [ 20, 40, 60, 80, 100 ].map(v => ({ value: v - FLOOR, label: String(v) })),
					ariaLabel: _('Temperature'),
					series: GROUPS.map(g => ({ values: points.map(p => ({ t: p.t, v: (p[g.key] != null) ? Math.max(0, p[g.key] - FLOOR) : null })) }))
				}),
				charts.legend(GROUPS.map((g, i) => ({ className: 'dashboard-series-' + (i + 1), label: g.label, value: celsius(last[g.key]) })))
			] : charts.empty(_('Collecting data...'))
		});
	},

	render(text) {
		const points = this.points(text);

		return {
			cards: [ { id: 'thermal', node: () => this.renderCard(points[points.length - 1]) } ],
			charts: [ { id: 'thermal', node: () => this.renderChart(points) } ]
		};
	}
});
