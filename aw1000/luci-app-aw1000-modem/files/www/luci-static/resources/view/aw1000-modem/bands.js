'use strict';
'require view';
'require fs';
'require ui';
'require aw1000.modem as modem';
'require aw1000.cell as rf';

// Network mode and the LTE/5G bands the modem may use (AT+QNWPREFCFG). The
// supported bands come from the modem's "policy_band"; the ones in use now
// from what aw1000-leds last read (serving cell and carrier aggregation).

const GROUPS = [
	{ key: 'lte_band', rat: 'LTE', title: _('LTE bands') },
	{ key: 'nsa_nr5g_band', rat: 'NR', title: _('5G NSA bands'), descr: _('The 5G leg added to an LTE connection (EN-DC).') },
	{ key: 'nr5g_band', rat: 'NR', title: _('5G SA bands'), descr: _('Standalone 5G, without LTE.') }
];

const MODES = [
	[ 'AUTO', _('Automatic') ],
	[ 'LTE:NR5G', _('LTE + 5G') ],
	[ 'LTE', _('LTE only') ],
	[ 'NR5G', _('5G only') ]
];

// AT+QNWPREFCFG="nr5g_disable_mode": 0 both, 1 SA off, 2 NSA off.
const NR_MODES = [
	[ '0', _('NSA and SA') ],
	[ '1', _('NSA only') ],
	[ '2', _('SA only') ]
];

const list = v => (v || '').split(':').filter(b => /^\d+$/.test(b)).map(Number).sort((a, b) => a - b);

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.all([
			modem.at('AT+QNWPREFCFG="policy_band"'),
			modem.at('AT+QNWPREFCFG="lte_band";+QNWPREFCFG="nsa_nr5g_band";+QNWPREFCFG="nr5g_band";+QNWPREFCFG="mode_pref";+QNWPREFCFG="nr5g_disable_mode"'),
			L.resolveDefault(fs.read('/tmp/aw1000-status/live'), '')
		]);
	},

	// The settings as the modem reports them: { mode, nrmode, lte_band: [ ... ], ... }.
	settings(reply) {
		const out = {};

		(rf.parse(reply).QNWPREFCFG || []).forEach(f => {
			if (f[0] == 'mode_pref')
				out.mode = f[1];
			else if (f[0] == 'nr5g_disable_mode')
				out.nrmode = f[1];
			else
				out[f[0]] = list(f[1]);
		});

		return out;
	},

	// "LTE:28", "NR:41": the bands of the serving cell and its secondary carriers.
	inUse(live) {
		const p = rf.parse(live);
		const cell = rf.servingCell(p.QENG);
		const used = new Set();

		[ cell.lte, cell.nr ].forEach(c => {
			if (c && c.band)
				used.add((c.band[0] == 'n' ? 'NR:' : 'LTE:') + c.band.slice(1));
		});

		(p.QCAINFO || []).forEach(f => {
			const m = (f[3] || '').match(/^(LTE|NR5G) BAND (\d+)/);

			if (m)
				used.add((m[1] == 'LTE' ? 'LTE:' : 'NR:') + m[2]);
		});

		return used;
	},

	changes() {
		const out = [];

		if (this.want.mode != this.have.mode)
			out.push('AT+QNWPREFCFG="mode_pref",' + this.want.mode);

		if (this.want.nrmode != this.have.nrmode)
			out.push('AT+QNWPREFCFG="nr5g_disable_mode",' + this.want.nrmode);

		GROUPS.forEach(g => {
			const a = this.want[g.key] || [], b = this.have[g.key] || [];

			if (a.join(':') != b.join(':'))
				out.push('AT+QNWPREFCFG="%s",%s'.format(g.key, a.join(':')));
		});

		return out;
	},

	update() {
		const n = this.changes().length;

		this.bar.hidden = !n;
		this.barText.textContent = (n == 1) ? _('1 change not applied') : _('%d changes not applied').format(n);

		this.segs.forEach(s => s.querySelectorAll('button').forEach(b => b.classList.toggle('on', this.want[s.dataset.key] == b.dataset.value)));

		GROUPS.forEach(g => {
			const box = this.chips[g.key];
			const on = this.want[g.key] || [];

			box.querySelectorAll('.aw-chip').forEach(c => {
				c.classList.toggle('on', on.includes(+c.dataset.band));
				c.setAttribute('aria-pressed', on.includes(+c.dataset.band) ? 'true' : 'false');
			});

			this.counts[g.key].textContent = _('%d of %d on').format(on.length, (this.supported[g.key] || []).length);
		});
	},

	segment(key, options) {
		const seg = E('div', { 'class': 'aw-seg', 'role': 'group', 'data-key': key }, options.map(([ value, label ]) =>
			E('button', { 'type': 'button', 'data-value': value, 'click': () => {
				this.want[key] = value;
				this.update();
			} }, [ label ])));

		this.segs.push(seg);

		return seg;
	},

	group(g) {
		const supported = this.supported[g.key] || [];
		const toggle = band => {
			const on = this.want[g.key];

			this.want[g.key] = on.includes(band) ? on.filter(b => b != band) : on.concat([ band ]).sort((a, b) => a - b);
			this.update();
		};

		this.chips[g.key] = E('div', { 'class': 'aw-chips' }, supported.map(band => {
			const name = rf.bandName(g.rat, band).split(' · ');
			const live = this.used.has(g.rat + ':' + band) && (g.key != 'nr5g_band' || this.mode == 'SA') && (g.key != 'nsa_nr5g_band' || this.mode == 'NSA');

			return E('button', {
				'type': 'button', 'class': 'aw-chip' + (live ? ' live' : ''), 'data-band': band,
				'title': live ? _('In use now') : null, 'click': () => toggle(band)
			}, [ E('b', {}, [ name[0] ]), E('small', {}, [ name[1] ? name[1] + ' MHz' : ' ' ]) ]);
		}));
		this.counts[g.key] = E('span', { 'class': 'aw-muted' });

		return E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'aw-row' }, [
				E('h3', { 'class': 'aw-spacer', 'style': 'margin:0' }, [ g.title ]),
				this.counts[g.key],
				E('button', { 'class': 'btn cbi-button', 'click': () => { this.want[g.key] = supported.slice(); this.update(); } }, [ _('All') ]),
				E('button', { 'class': 'btn cbi-button', 'click': () => { this.want[g.key] = []; this.update(); } }, [ _('None') ])
			]),
			g.descr ? E('div', { 'class': 'cbi-section-descr' }, [ g.descr ]) : '',
			supported.length ? this.chips[g.key] : E('div', { 'class': 'aw-empty' }, [ _('The modem reports no supported bands here.') ])
		]);
	},

	apply() {
		const cmds = this.changes();
		const empty = GROUPS.filter(g => (this.supported[g.key] || []).length && !(this.want[g.key] || []).length);

		if (empty.length) {
			ui.addNotification(null, E('p', {}, [ _('Choose at least one band in: %s').format(empty.map(g => g.title).join(', ')) ]), 'warning');
			return;
		}

		ui.showModal(_('Apply band settings'), [
			E('p', {}, [ _('The modem re-registers with the new settings, and mobile data may drop for a few seconds.') ]),
			E('pre', { 'class': 'aw-mono', 'style': 'white-space:pre-wrap' }, [ cmds.join('\n') ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]), ' ',
				E('button', { 'class': 'btn cbi-button-action', 'click': () => {
					ui.showModal(_('Apply band settings'), [ E('p', { 'class': 'spinning' }, [ _('Sending to the modem...') ]) ]);

					const failed = [];

					return cmds.reduce((p, cmd) => p.then(() => modem.at(cmd).then(res => {
						if (res.code != 0)
							failed.push('%s: %s'.format(cmd, res.output || res.code));
					})), Promise.resolve()).then(() => {
						ui.hideModal();

						if (failed.length)
							ui.addNotification(null, E('pre', {}, [ failed.join('\n') ]), 'error');
						else
							ui.addTimeLimitedNotification(null, E('p', {}, [ _('Band settings applied.') ]), 5000, 'info');

						return this.load().then(data => this.refresh(data));
					});
				} }, [ _('Apply') ])
			])
		]);
	},

	refresh([ policy, current, live ]) {
		const root = this.render([ policy, current, live ]);

		this.root.replaceWith(root);
	},

	render([ policy, current, live ]) {
		const sup = this.settings(policy.output);
		const cur = this.settings(current.output);

		this.supported = {};
		GROUPS.forEach(g => { this.supported[g.key] = sup[g.key] || []; });
		this.have = cur;
		this.want = JSON.parse(JSON.stringify(cur));
		this.used = this.inUse(live);
		this.mode = rf.servingCell(rf.parse(live).QENG).mode;
		this.segs = [];
		this.chips = {};
		this.counts = {};

		this.barText = E('span', { 'class': 'aw-spacer' });
		this.bar = E('div', { 'class': 'aw-applybar', 'hidden': '' }, [
			this.barText,
			E('button', { 'class': 'btn cbi-button', 'click': () => {
				this.want = JSON.parse(JSON.stringify(this.have));
				this.update();
			} }, [ _('Undo') ]),
			E('button', { 'class': 'btn cbi-button cbi-button-apply', 'click': () => this.apply() }, [ _('Apply') ])
		]);

		const usedNames = [ ...this.used ].map(u => u.replace(/^LTE:/, 'B').replace(/^NR:/, 'n'));
		const failed = (policy.code != 0 || current.code != 0);

		this.root = E('div', { 'class': 'aw' }, [
			modem.css(),
			E('h2', {}, [ _('Bands') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Which networks and bands the modem may use. Turning bands off steers it to the others; it does not make a weak band stronger.')
			]),
			failed ? E('div', { 'class': 'alert-message warning' }, [ _('The modem did not answer: %s').format(policy.output || current.output) ]) : '',
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'aw-row' }, [
					E('h3', { 'class': 'aw-spacer', 'style': 'margin:0' }, [ _('Network mode') ]),
					usedNames.length ? E('span', { 'class': 'aw-legend' }, [ _('In use now: %s').format(usedNames.join(' + ')) ]) : ''
				]),
				E('div', { 'class': 'aw-stack', 'style': 'margin-top:.75em' }, [
					E('div', { 'class': 'aw-row' }, [ E('span', { 'style': 'min-width:7em' }, [ _('Networks') ]), this.segment('mode', MODES) ]),
					E('div', { 'class': 'aw-row' }, [ E('span', { 'style': 'min-width:7em' }, [ _('5G modes') ]), this.segment('nrmode', NR_MODES) ])
				])
			])
		].concat(GROUPS.map(g => this.group(g))).concat([ this.bar ]));

		this.update();

		return this.root;
	}
});
