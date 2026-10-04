'use strict';
'require baseclass';
'require fs';
'require view.dashboard.lib.charts as charts';

// The connections ECM has offloaded to the NSS firmware, as /usr/sbin/aw1000-leds
// records them every poll. The firmware's own load figure is not among them:
// it is only refreshed while the NSS clock scales itself, which is off here.
const FILE = '/tmp/aw1000-status/nss';

function num(v) {
	return (v != null && /^\d+$/.test(v)) ? +v : null;
}

// A round top for the chart: 1, 2 or 5 times a power of ten.
function top(v) {
	const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 10))));

	return [ 1, 2, 5, 10 ].map(m => m * p).find(m => m >= v);
}

return baseclass.extend({
	widgets: [
		{ id: 'nss', slot: 'cards', title: _('NSS offload'), order: 25 },
		{ id: 'nss', slot: 'charts', title: _('NSS offload'), order: 22 }
	],

	available() {
		return L.resolveDefault(fs.stat(FILE), null).then(st => st != null);
	},

	load() {
		return L.resolveDefault(fs.read(FILE), '');
	},

	points(text) {
		return text.split('\n').map(line => line.split(' ')).filter(f => f.length == 3).map(f => ({
			t: +f[0] * 1000, v4: num(f[1]), v6: num(f[2])
		}));
	},

	renderCard(last) {
		const total = last ? (last.v4 || 0) + (last.v6 || 0) : null;

		return charts.kpi({
			icon: 'nss',
			title: _('NSS offload'),
			value: [ (total != null) ? N_(total, '%d flow', '%d flows').format(total) : '-' ],
			sub: last ? [ _('IPv4 %d').format(last.v4 || 0), _('IPv6 %d').format(last.v6 || 0) ] : []
		});
	},

	renderChart(points) {
		const last = points[points.length - 1];
		const span = points.length > 1 ? Math.max(60, (last.t - points[0].t) / 1000) : 300;
		const max = top(Math.max(0, ...points.map(p => (p.v4 || 0) + (p.v6 || 0))));
		const count = v => (v != null) ? String(v) : '-';

		return charts.card({
			title: _('NSS offload'),
			desc: _('connections forwarded by the NSS firmware'),
			body: points.length ? [
				charts.lines({
					span: span,
					max: max,
					ticks: [ 0, 0.25, 0.5, 0.75, 1 ].map(f => ({ value: f * max, label: String(Math.round(f * max)) })),
					ariaLabel: _('NSS offload'),
					series: [
						{ values: points.map(p => ({ t: p.t, v: p.v4 })), area: true },
						{ values: points.map(p => ({ t: p.t, v: p.v6 })) }
					]
				}),
				charts.legend([
					{ className: 'dashboard-series-1', label: _('IPv4'), value: count(last.v4) },
					{ className: 'dashboard-series-2', label: _('IPv6'), value: count(last.v6) }
				])
			] : charts.empty(_('Collecting data...'))
		});
	},

	render(text) {
		const points = this.points(text);

		return {
			cards: [ { id: 'nss', node: () => this.renderCard(points[points.length - 1]) } ],
			charts: [ { id: 'nss', node: () => this.renderChart(points) } ]
		};
	}
});
