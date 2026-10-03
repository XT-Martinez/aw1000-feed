'use strict';
'require view';
'require aw1000.modem as modem';
'require aw1000.cell as rf';

// AT command console on the modem's first AT port. Commands that can take
// longer than LuCI waits for a request (a network search, a cell scan) run
// as a background job on the router.

const QUICK = [
	[ _('Modem'), [ 'ATI', 'AT+CGSN', 'AT+QCCID', 'AT+CIMI', 'AT+QTEMP', 'AT+QUIMSLOT?' ] ],
	[ _('Signal'), [ 'AT+QENG="servingcell"', 'AT+QCAINFO', 'AT+CSQ', 'AT+QENG="neighbourcell"' ] ],
	[ _('Network'), [ 'AT+COPS?', 'AT+CEREG?', 'AT+C5GREG?', 'AT+QSPN', 'AT+QNWPREFCFG="mode_pref"', 'AT+QNWLOCK="common/4g"' ] ],
	[ _('Data'), [ 'AT+CGDCONT?', 'AT+CGCONTRDP', 'AT+CGPADDR', 'AT+QNETDEVCTL?' ] ]
];

// Known to take long: always a background job.
const SLOW = /^AT\+(COPS=\?|QSCAN)/i;

const HISTORY_KEY = 'aw1000-at-history';

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	history() {
		try {
			return JSON.parse(window.localStorage.getItem(HISTORY_KEY)) || [];
		}
		catch (e) {
			return [];
		}
	},

	remember(cmd) {
		const list = this.history().filter(c => c != cmd);

		list.push(cmd);

		try {
			window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-50)));
		}
		catch (e) {}
	},

	run(cmd) {
		cmd = cmd.trim();

		if (!cmd || this.busy)
			return;

		if (!/^AT/i.test(cmd))
			cmd = 'AT' + cmd;

		const wait = +this.wait.value;
		const slow = wait > 15 || SLOW.test(cmd);
		const meta = E('div', { 'class': 'meta' }, [ _('Waiting for the modem...') ]);
		const entry = E('div', { 'class': 'entry' }, [ E('div', { 'class': 'cmd' }, [ cmd ]), meta ]);
		const started = Date.now();

		this.remember(cmd);
		this.pos = null;
		this.input.value = '';
		this.setBusy(true);
		this.term.appendChild(entry);
		this.term.scrollTop = this.term.scrollHeight;

		const done = slow
			? modem.job(cmd, (wait > 15) ? wait : 180, (elapsed, timeout) => {
				meta.textContent = _('Running in the background: %d s of up to %d s').format(elapsed, timeout);
			})
			: modem.at(cmd, wait);

		return done.then(res => {
			const lines = (res.output || '').split('\n').filter(l => l.length);

			entry.removeChild(meta);
			lines.forEach((line, i) => {
				const last = (i == lines.length - 1);
				const cls = (last && res.code == 0) ? 'ok' : ((last || res.code == 3) && res.code != 0) ? 'err' : '';

				entry.appendChild(E('div', { 'class': cls }, [ line ]));
			});

			if (res.code == 2)
				entry.appendChild(E('div', { 'class': 'err' }, [ _('No answer within the time allowed') ]));

			entry.appendChild(E('div', { 'class': 'meta' }, [ '%.1f s'.format((Date.now() - started) / 1000) ]));
		}).finally(() => {
			this.setBusy(false);
			this.term.scrollTop = this.term.scrollHeight;
			this.input.focus();
		});
	},

	setBusy(busy) {
		this.busy = busy;
		this.send.disabled = busy;
		this.input.disabled = busy;
	},

	// Up and down walk through earlier commands, as in a shell.
	handleKey(ev) {
		const list = this.history();

		if (ev.key == 'Enter') {
			ev.preventDefault();
			this.run(this.input.value);
		}
		else if (ev.key == 'ArrowUp' && list.length) {
			ev.preventDefault();
			this.pos = (this.pos == null) ? list.length - 1 : Math.max(0, this.pos - 1);
			this.input.value = list[this.pos];
		}
		else if (ev.key == 'ArrowDown' && this.pos != null) {
			ev.preventDefault();
			this.pos++;
			this.input.value = (this.pos < list.length) ? list[this.pos] : '';

			if (this.pos >= list.length)
				this.pos = null;
		}
	},

	render() {
		this.term = E('div', { 'class': 'aw-term', 'role': 'log', 'aria-live': 'polite' }, [
			E('div', { 'class': 'meta' }, [
				_('Commands go straight to the modem. Some (AT+CFUN, AT+QCFG, AT+QNWLOCK and others) disconnect it or change settings that outlast a restart.')
			])
		]);
		this.input = E('input', {
			'type': 'text', 'class': 'cbi-input-text', 'placeholder': 'AT+...', 'spellcheck': 'false',
			'autocomplete': 'off', 'autocapitalize': 'off', 'aria-label': _('AT command'),
			'keydown': ev => this.handleKey(ev)
		});
		this.wait = E('select', { 'class': 'cbi-input-select', 'aria-label': _('Time to wait'), 'title': _('Time to wait for the answer') }, [
			E('option', { 'value': '10' }, [ _('10 s') ]),
			E('option', { 'value': '60' }, [ _('1 min') ]),
			E('option', { 'value': '300' }, [ _('5 min') ])
		]);
		this.send = E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': () => this.run(this.input.value) }, [
			rf.icon('send'), ' ', _('Send')
		]);

		const quick = E('div', { 'class': 'aw-quick' }, QUICK.flatMap(([ title, cmds ]) => [
			E('h5', {}, [ title ])
		].concat(cmds.map(cmd => E('button', { 'type': 'button', 'title': _('Run %s').format(cmd), 'click': () => this.run(cmd) }, [ cmd ])))));

		return E('div', { 'class': 'aw' }, [
			modem.css(),
			E('h2', {}, [ _('AT commands') ]),
			E('div', { 'class': 'cbi-section' }, [
				this.term,
				E('div', { 'class': 'aw-prompt' }, [ this.input, this.wait, this.send ]),
				E('div', { 'class': 'aw-row', 'style': 'margin-top:.4em' }, [
					E('small', { 'class': 'aw-muted aw-spacer' }, [ _('Enter sends, Up and Down go through earlier commands. AT+COPS=? and AT+QSCAN always run in the background.') ]),
					E('button', { 'class': 'aw-iconbtn', 'title': _('Clear'), 'click': () => {
						while (this.term.childNodes.length > 1)
							this.term.removeChild(this.term.lastChild);
					} }, [ rf.icon('trash'), ' ', _('Clear') ])
				])
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Common commands') ]),
				quick
			])
		]);
	}
});
