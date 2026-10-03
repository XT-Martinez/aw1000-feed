'use strict';
'require view';
'require ui';
'require aw1000.modem as modem';
'require aw1000.cell as rf';
'require aw1000.plmn as plmn';

// The serving cell, cell locks (AT+QNWLOCK) and the cells around: the
// modem's neighbour list (instant, own operator) or a full scan of every
// operator (AT+QSCAN, about 100 s, run as a background job).

const SERVING = 'AT+QENG="servingcell";+QNWLOCK="common/4g";+QNWLOCK="common/5g";+QSPN';
const SCAN = 'AT+QSCAN=3,1';
const SCAN_TIME = 100;

// <scs> of +QSCAN for NR: 0-4 for 15-240 kHz; AT+QNWLOCK takes kHz.
const SCS = [ 15, 30, 60, 120, 240 ];

// LTE cells AT+QNWLOCK="common/4g" takes at once.
const MAX_LOCK = 10;

function fmtTime(epoch) {
	const d = new Date(epoch * 1000);

	return '%02d:%02d'.format(d.getHours(), d.getMinutes());
}

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.all([ modem.at(SERVING), modem.at('AT+QENG="neighbourcell"'), modem.jobStatus() ]);
	},

	// +QSCAN: "LTE",<mcc>,<mnc>,<earfcn>,<pci>,<rsrp>,<rsrq>,<srxlev>,<squal>,<cellid>,<tac>,<rb>,<band>
	//         "NR5G",<mcc>,<mnc>,<arfcn>,<pci>,<rsrp>,<rsrq>,<srxlev>,<scs>,<cellid>,<tac>,<bw>,<band>
	scanCells(output) {
		return (rf.parse(output).QSCAN || []).filter(f => f.length >= 9).map(f => {
			const nr = (f[0] == 'NR5G');

			return {
				rat: nr ? 'NR' : 'LTE', plmn: f[1] + f[2], arfcn: f[3], pci: f[4], rsrp: rf.num(f[5]), rsrq: rf.num(f[6]),
				scs: nr ? (rf.num(f[8]) < SCS.length ? SCS[rf.num(f[8])] : rf.num(f[8])) : null,
				cid: f[9] || null, tac: f[10] || null,
				bw: nr ? rf.NR_BW[rf.num(f[11])] : rf.LTE_RB[rf.num(f[11])],
				band: rf.num(f[12]) || (nr ? null : rf.lteBand(f[3]))
			};
		});
	},

	// +QENG: "neighbourcell intra|inter","LTE",<earfcn>,<pci>,<rsrq>,<rsrp>,<rssi>,<sinr>,...
	// The modem lists its own operator's cells only.
	neighbourCells(output, ownPlmn) {
		return (rf.parse(output).QENG || []).filter(f => /^neighbourcell/.test(f[0]) && f[1] == 'LTE' && rf.num(f[3]) != null).map(f => ({
			rat: 'LTE', plmn: ownPlmn, arfcn: f[2], pci: f[3], rsrq: rf.num(f[4]), rsrp: rf.num(f[5]), band: rf.lteBand(f[2])
		}));
	},

	// The locks: { lte: [ [ earfcn, pci ], ... ], nr: [ pci, arfcn, scs, band ] or null, and as text }
	locks(p) {
		const get = key => {
			const hit = (p.QNWLOCK || []).find(f => f[0] == key);

			return hit ? hit.slice(1) : null;
		};
		const l4 = get('common/4g'), l5 = get('common/5g');
		const lte = [];

		for (let i = 1; l4 && i + 1 < l4.length && lte.length < rf.num(l4[0]); i += 2)
			lte.push([ l4[i], l4[i + 1] ]);

		return {
			lte: lte, lteText: rf.lockText('common/4g', l4),
			nr: (l5 && l5[0] != '0') ? l5 : null, nrText: rf.lockText('common/5g', l5)
		};
	},

	isServing(c) {
		const s = this.cell;

		return (c.rat == 'LTE' && s.lte && s.lte.arfcn == c.arfcn && s.lte.pci == c.pci) ||
			(c.rat == 'NR' && s.nr && s.nr.arfcn == c.arfcn && s.nr.pci == c.pci);
	},

	operator(code) {
		return plmn.name(code) || (code ? '%s %s'.format(code.slice(0, 3), code.slice(3)) : '-');
	},

	stat(label, value, title) {
		return E('div', { 'class': 'aw-stat', 'title': title || null }, [ E('small', {}, [ label ]), E('strong', {}, [ value ]) ]);
	},

	renderServing() {
		const c = this.cell, op = this.qspn;
		const tiles = [
			this.stat(_('Technology'), c.mode ? rf.MODES[c.mode] : _('No service')),
			this.stat(_('Operator'), op ? '%s · %s %s'.format(op[0], (op[4] || '').slice(0, 3), (op[4] || '').slice(3)) : '-')
		];
		const leg = (name, x, rat) => {
			if (!x)
				return;

			tiles.push(
				this.stat(_('%s band').format(name), rf.bandName(rat, x.band.slice(1))),
				this.stat(rat == 'NR' ? _('ARFCN / PCI') : _('EARFCN / PCI'), '%s / %s'.format(x.arfcn || '-', x.pci || '-')),
				this.stat(_('%s RSRP').format(name), rf.signal('rsrp', x.rsrp)),
				this.stat(_('%s RSRQ / SINR').format(name), '%s / %s'.format(rf.dbm(x.rsrq, 'dB'), rf.dbm(x.sinr, 'dB')))
			);
		};

		leg(_('LTE'), c.lte, 'LTE');
		leg(_('5G'), c.nr, 'NR');

		return E('div', { 'class': 'aw-stats' }, tiles);
	},

	renderLocks() {
		const l = this.lock;
		const row = (title, text, unlock) => E('div', { 'class': 'aw-row', 'style': 'margin:.35em 0' }, [
			E('span', { 'style': 'min-width:5.5em' }, [ title ]),
			text ? E('span', { 'class': 'aw-pill accent' }, [ rf.icon('lock'), text ]) : E('span', { 'class': 'aw-pill' }, [ rf.icon('unlock'), _('Not locked') ]),
			text ? E('button', { 'class': 'btn cbi-button cbi-button-negative', 'click': () => this.confirm(_('Unlock'), _('Unlock'),
				[ _('The modem may move to any cell again.') ], unlock) }, [ _('Unlock') ]) : ''
		]);

		return E('div', {}, [
			row(_('LTE'), l.lteText, () => modem.lock([], null)),
			row(_('5G SA'), l.nrText, () => modem.lock(null, '')),
			E('div', { 'class': 'cbi-section-descr', 'style': 'margin-top:.6em' }, [
				_('Locks are kept on the router and sent to the modem again each time the mobile connection starts, so they outlast a modem restart.')
			])
		]);
	},

	// The table of nearby cells, the serving ones first, then by RSRP.
	renderCells() {
		const own = this.qspn ? this.qspn[4] : null;
		const cells = (this.cells || []).filter(c => !this.ownOnly || !own || c.plmn == own).slice();

		cells.forEach(c => { c.serving = this.isServing(c); });
		cells.sort((a, b) => (b.serving - a.serving) || ((b.rsrp != null ? b.rsrp : -999) - (a.rsrp != null ? a.rsrp : -999)));

		const locked = c => c.rat == 'LTE' && this.lock.lte.some(p => p[0] == c.arfcn && p[1] == c.pci);
		const key = c => c.rat + ':' + c.arfcn + ':' + c.pci;

		if (!cells.length)
			return E('div', { 'class': 'aw-empty' }, [ this.cells ? _('No cells found.') : _('Run a scan to see the cells around.') ]);

		const head = [ '', _('Operator'), _('Band'), _('EARFCN / PCI'), _('Cell'), _('RSRP'), _('RSRQ'), _('Bandwidth'), '' ];
		const rows = cells.map(c => {
			const cid = c.cid ? parseInt(c.cid, 16) : NaN;
			const canLock = c.rat == 'LTE' || c.scs != null;
			const box = (c.rat == 'LTE') ? E('input', {
				'type': 'checkbox', 'aria-label': _('Select'), 'checked': this.selected.has(key(c)) ? '' : null,
				'change': ev => {
					ev.target.checked ? this.selected.add(key(c)) : this.selected.delete(key(c));
					this.updateSelection();
				}
			}) : '';

			return E('tr', { 'class': 'tr' + (c.serving ? ' aw-serving' : '') + (own && c.plmn != own ? ' aw-other' : '') }, [
				E('td', { 'class': 'td' }, [ box ]),
				E('td', { 'class': 'td', 'data-title': head[1] }, [ this.operator(c.plmn) ]),
				E('td', { 'class': 'td', 'data-title': head[2] }, [ c.band ? rf.bandName(c.rat, c.band) : '-' ]),
				E('td', { 'class': 'td', 'data-title': head[3] }, [ '%s / %s'.format(c.arfcn, c.pci) ]),
				E('td', { 'class': 'td', 'data-title': head[4], 'title': c.cid ? _('Cell ID %s, TAC %s').format(c.cid, c.tac || '-') : null }, [
					isNaN(cid) ? '-' : (c.rat == 'LTE' ? '%d-%d'.format(cid >> 8, cid & 255) : String(cid))
				]),
				E('td', { 'class': 'td', 'data-title': head[5] }, [ rf.signal('rsrp', c.rsrp) ]),
				E('td', { 'class': 'td', 'data-title': head[6] }, [ rf.dbm(c.rsrq, 'dB') ]),
				E('td', { 'class': 'td', 'data-title': head[7] }, [ c.bw ? '%s MHz'.format(c.bw) : '-' ]),
				E('td', { 'class': 'td right' }, [
					c.serving ? E('span', { 'class': 'aw-pill good' }, [ _('Serving') ]) : '',
					locked(c) ? E('span', { 'class': 'aw-pill accent' }, [ rf.icon('lock'), _('Locked') ]) : '',
					(canLock && !locked(c)) ? E('button', { 'class': 'aw-iconbtn', 'title': _('Lock to this cell'), 'click': () => this.lockCells([ c ]) }, [
						rf.icon('lock'), _('Lock')
					]) : ''
				])
			]);
		});

		return E('table', { 'class': 'table aw-cells' }, [
			E('tr', { 'class': 'tr table-titles' }, head.map(h => E('th', { 'class': 'th' }, [ h ])))
		].concat(rows));
	},

	updateSelection() {
		const n = this.selected.size;

		this.lockSelected.disabled = !n || n > MAX_LOCK;
		this.lockSelected.textContent = n ? _('Lock to %d selected').format(n) : _('Lock to selected');
		this.lockSelected.title = (n > MAX_LOCK) ? _('At most %d cells').format(MAX_LOCK) : '';
	},

	lockCells(list) {
		const lte = list.filter(c => c.rat == 'LTE');
		const nr = list.find(c => c.rat == 'NR');
		const names = list.map(c => '%s · %s %s · PCI %s (%s)'.format(c.band ? rf.bandName(c.rat, c.band).split(' · ')[0] : c.rat,
			c.rat == 'NR' ? 'ARFCN' : 'EARFCN', c.arfcn, c.pci, this.operator(c.plmn)));
		const set = nr && !lte.length
			? () => modem.lock(null, [ nr.pci, nr.arfcn, nr.scs, nr.band ].join(','))
			: () => modem.lock(lte.map(c => c.arfcn + ',' + c.pci), null);
		const notes = [ _('The modem detaches and attaches to the chosen cell: mobile data drops for a few seconds, longer if the cell does not take it.') ];

		if (nr && !lte.length)
			notes.push(_('A 5G cell lock applies on 5G SA only. For 5G NSA, lock the LTE cell that carries it.'));

		if (list.some(c => this.qspn && c.plmn != this.qspn[4]))
			notes.push(_('Some of these are another operator\'s cells: the SIM cannot use them unless roaming allows it.'));

		this.confirm(_('Lock to cells'), _('Lock'), [ E('ul', {}, names.map(n => E('li', {}, [ n ]))) ].concat(notes.map(n => E('p', {}, [ n ]))), set);
	},

	// Asks, runs set() (a modem.lock() call), then waits for the modem to
	// be on a cell again.
	confirm(title, action, body, set) {
		ui.showModal(title, body.map(b => (typeof b == 'string') ? E('p', {}, [ b ]) : b).concat([
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]), ' ',
				E('button', { 'class': 'btn cbi-button-action', 'click': () => this.send(set) }, [ action ])
			])
		]));
	},

	send(set) {
		ui.showModal(_('Waiting for the modem'), [ E('p', { 'class': 'spinning' }, [ _('Sending...') ]) ]);

		return set().then(res => {
			if (res.code != 0) {
				ui.hideModal();
				ui.addNotification(null, E('p', {}, [ _('The modem did not take it: %s').format(res.output) ]), 'error');
				return;
			}

			ui.showModal(_('Waiting for the modem'), [ E('p', { 'class': 'spinning' }, [ _('Attaching to the network...') ]) ]);

			// Up to 30 s for a serving cell again.
			const wait = (tries) => new Promise(r => window.setTimeout(r, 3000)).then(() => modem.at(SERVING)).then(res => {
				const cell = rf.servingCell(rf.parse(res.output).QENG);

				return (cell.mode || tries <= 1) ? res : wait(tries - 1);
			});

			return wait(10).then(res => {
				ui.hideModal();
				this.selected.clear();
				this.setServing(res);
				this.redraw();
			});
		});
	},

	scan() {
		this.scanning = true;
		this.redraw();

		const bar = this.progress.firstChild;

		return modem.job(SCAN, 240, elapsed => {
			bar.style.width = '%d%%'.format(Math.min(98, elapsed * 100 / SCAN_TIME));
			this.progressText.textContent = _('Scanning every band and operator: %d s of about %d s').format(elapsed, SCAN_TIME);
		}).then(res => {
			this.scanning = false;

			if (res.code != 0) {
				ui.addNotification(null, E('p', {}, [ _('Scan failed: %s').format(res.output || res.code) ]), 'error');
			}
			else {
				this.cells = this.scanCells(res.output);
				this.source = _('Full scan at %s').format(fmtTime(Date.now() / 1000));
				this.ownOnly = false;
			}

			this.redraw();
		});
	},

	quick() {
		return modem.at('AT+QENG="neighbourcell"').then(res => {
			this.cells = this.neighbourCells(res.output, this.qspn ? this.qspn[4] : null);
			this.source = _('Neighbour list at %s (own operator only)').format(fmtTime(Date.now() / 1000));
			this.redraw();
		});
	},

	setServing(res) {
		const p = rf.parse(res.output);

		this.cell = rf.servingCell(p.QENG);
		this.lock = this.locks(p);
		this.qspn = p.QSPN ? p.QSPN[0] : null;
	},

	redraw() {
		this.servingBox.replaceChildren(this.renderServing());
		this.lockBox.replaceChildren(this.renderLocks());
		this.cellBox.replaceChildren(this.renderCells());
		this.sourceText.textContent = this.source || '';
		this.progress.parentNode.hidden = !this.scanning;
		this.scanBtn.disabled = !!this.scanning;
		this.ownBox.checked = !!this.ownOnly;
		this.ownLabel.textContent = _('Only %s').format(this.qspn ? this.qspn[0] : _('my operator'));
		this.updateSelection();
	},

	render([ serving, neighbours, job ]) {
		this.setServing(serving);
		this.selected = new Set();
		this.ownOnly = true;

		// A scan from earlier, or still running (the page was reloaded).
		if (job.command == SCAN && !job.running && job.code == 0) {
			this.cells = this.scanCells(job.output);
			this.source = _('Full scan at %s').format(fmtTime(job.started));
		}
		else {
			this.cells = this.neighbourCells(neighbours.output, this.qspn ? this.qspn[4] : null);
			this.source = _('Neighbour list (own operator only)');
		}

		this.servingBox = E('div');
		this.lockBox = E('div');
		this.cellBox = E('div', { 'style': 'overflow-x:auto' });
		this.sourceText = E('small', { 'class': 'aw-muted' });
		this.progress = E('div', { 'class': 'aw-progress' }, [ E('div') ]);
		this.progressText = E('small', { 'class': 'aw-muted' }, [ _('Starting the scan...') ]);
		this.scanBtn = E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': () => this.scan() }, [
			rf.icon('radar'), ' ', _('Full scan (about 2 min)')
		]);
		this.lockSelected = E('button', { 'class': 'btn cbi-button', 'disabled': '', 'click': () => {
			this.lockCells((this.cells || []).filter(c => this.selected.has(c.rat + ':' + c.arfcn + ':' + c.pci)));
		} }, [ _('Lock to selected') ]);
		this.ownBox = E('input', { 'type': 'checkbox', 'id': 'aw-own', 'change': ev => {
			this.ownOnly = ev.target.checked;
			this.redraw();
		} });
		this.ownLabel = E('label', { 'for': 'aw-own' });

		const root = E('div', { 'class': 'aw' }, [
			modem.css(),
			E('h2', {}, [ _('Cell lock') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Keep the modem on chosen cells. A locked modem does not move to another cell even when the locked one fails: unlock it to go back to normal.')
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'aw-row' }, [
					E('h3', { 'class': 'aw-spacer', 'style': 'margin:0' }, [ _('Serving cell') ]),
					E('button', { 'class': 'aw-iconbtn', 'title': _('Refresh'), 'click': () => modem.at(SERVING).then(res => {
						this.setServing(res);
						this.redraw();
					}) }, [ rf.icon('refresh') ])
				]),
				E('div', { 'style': 'margin-top:.75em' }, [ this.servingBox ])
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Locks') ]),
				this.lockBox
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Cells around') ]),
				E('div', { 'class': 'aw-row' }, [
					this.scanBtn,
					E('button', { 'class': 'btn cbi-button', 'click': () => this.quick() }, [ rf.icon('refresh'), ' ', _('Neighbour list') ]),
					E('span', { 'class': 'aw-row' }, [ this.ownBox, this.ownLabel ]),
					E('span', { 'class': 'aw-spacer' }),
					this.lockSelected
				]),
				E('div', { 'hidden': '' }, [ this.progress, this.progressText ]),
				E('div', { 'style': 'margin:.5em 0' }, [ this.sourceText ]),
				this.cellBox
			])
		]);

		this.redraw();

		if (job.command == SCAN && job.running)
			this.scan();

		return root;
	}
});
