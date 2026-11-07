'use strict';
'require view';
'require dom';
'require poll';
'require rpc';
'require uci';
'require ui';
'require aw1000.modem as modem';
'require aw1000.cell as rf';
'require aw1000.webphone as webphone';

// The RJ11 phone port: an ordinary phone makes and takes the SIM's calls,
// served by the awvoice daemon (awvoice-phoned, ubus object "awvoice"). Its
// settings live in /etc/config/awvoice, section main; the daemon reads them
// again on "reload". Switching it on and off goes through our own backend,
// which also hands the modem's first AT port and the phone LED over.
//
// The Call panel is the phone in the browser (awvoice 1.1.4): it places,
// answers and ends calls with the daemon's web_* methods, and carries the
// call's audio over the daemon's encrypted WebSocket (aw1000/webphone.js).
// One owner of a call's audio at a time: the handset, the answering machine
// or this page.
//
// The page never fails to render: with the service off every ubus call of
// the daemon fails, and that is simply the "off" state.

const CONF = 'awvoice', SECT = 'main';

const callStatus = rpc.declare({ object: 'awvoice', method: 'status' });
const callHealth = rpc.declare({ object: 'awvoice', method: 'health' });
const callCalls = rpc.declare({ object: 'awvoice', method: 'calls' });
const callCallsDelete = rpc.declare({ object: 'awvoice', method: 'calls_delete', params: [ 'type' ] });
const callHangup = rpc.declare({ object: 'awvoice', method: 'hangup' });
const callReload = rpc.declare({ object: 'awvoice', method: 'reload' });
const callRecording = rpc.declare({ object: 'awvoice', method: 'recording_get', params: [ 'name', 'offset' ] });
const callMessage = rpc.declare({ object: 'awvoice', method: 'message_get', params: [ 'name', 'offset' ] });
const callCallStatus = rpc.declare({ object: 'awvoice', method: 'call_status' });
const callWebDial = rpc.declare({ object: 'awvoice', method: 'web_originate', params: [ 'number' ] });
const callWebAnswer = rpc.declare({ object: 'awvoice', method: 'web_answer' });
const callWebReject = rpc.declare({ object: 'awvoice', method: 'web_reject' });
const callWebHangup = rpc.declare({ object: 'awvoice', method: 'web_hangup' });
const callWebDtmf = rpc.declare({ object: 'awvoice', method: 'web_dtmf', params: [ 'digit' ] });
const callWebFlash = rpc.declare({ object: 'awvoice', method: 'web_flash' });
const callWebAudio = rpc.declare({ object: 'awvoice', method: 'web_audio_open', params: [ 'call_revision' ] });
const callCommit = rpc.declare({ object: 'uci', method: 'commit', params: [ 'config' ] });
const callPhone = rpc.declare({ object: 'luci.aw1000-modem', method: 'phone', params: [ 'action' ] });

const STATES = {
	idle: [ _('Ready'), 'good' ],
	offhook: [ _('Handset lifted'), 'accent' ],
	ring: [ _('Ringing'), 'accent' ],
	call: [ _('In call'), 'accent' ],
	noservice: [ _('No service'), 'warn' ],
	down: [ _('Not ready'), 'warn' ]
};

const RESULTS = {
	answered: '',
	missed: _('Missed'),
	rejected: _('Rejected'),
	blocked: _('Blocked'),
	busy: _('Busy'),
	no_answer: _('No answer'),
	failed: _('Failed')
};

const FILTERS = [
	[ '', _('All') ],
	[ 'MISS', _('Missed') ],
	[ 'IN', _('Received') ],
	[ 'OUT', _('Dialled') ]
];

// The settings on this page: option, default, and the choices of a
// segmented control, or [ min, max, unit ] for a number.
const SETTINGS = [
	{ title: _('Caller ID'), descr: _('How the caller\'s number reaches the handset\'s display. Most handsets in Asia and Europe read DTMF or ETSI FSK; North American ones read Bellcore FSK.'), rows: [
		{ opt: 'cid', def: 'dtmf', label: _('Format'), choices: [ [ 'dtmf', 'DTMF' ], [ 'etsi', _('FSK (ETSI)') ], [ 'bellcore', _('FSK (Bellcore)') ], [ 'off', _('Off') ] ] },
		{ opt: 'cid_when', def: 'ring1', label: _('Sent'), choices: [ [ 'ring1', _('After the first ring') ], [ 'prering', _('Before the first ring') ] ] },
		{ opt: 'clir', def: 'network', label: _('Show my number'), choices: [ [ 'network', _('Network default') ], [ 'show', _('Show') ], [ 'hide', _('Hide') ] ] }
	] },
	{ title: _('Calling'), rows: [
		{ opt: 'call_waiting', def: '1', label: _('Call waiting'), choices: [ [ '1', _('On') ], [ '0', _('Off') ] ] },
		{ opt: 'conference', def: '0', label: _('Three-way calls'), descr: _('Flash, then 3, joins the held call.'), choices: [ [ '1', _('On') ], [ '0', _('Off') ] ] },
		{ opt: 'ringback', def: 'auto', label: _('Ringback tone'), descr: _('Automatic plays the router\'s own tone until the network\'s is heard.'), choices: [ [ 'auto', _('Automatic') ], [ 'on', _('Router') ], [ 'off', _('Network') ] ] },
		{ opt: 'hd', def: '0', label: _('HD voice'), descr: _('16 kHz wideband audio, where the network and the handset carry it. Saving a change restarts the modem: mobile data drops for about half a minute.'), choices: [ [ '1', _('On') ], [ '0', _('Off') ] ] },
		{ opt: 'dial_pause_s', def: '6', label: _('Dial after'), descr: _('Seconds after the last digit before the number is dialled.'), range: [ 3, 15, 's' ] }
	] },
	{ title: _('Handset'), descr: _('A hook break shorter than the minimum is ignored, one between the two is the flash (R) key, a longer one hangs up. Set the maximum a little above the handset\'s own flash time (100 ms key: 300; 600 ms: 800; 1000 ms: 1200).'), rows: [
		{ opt: 'flash_min_ms', def: '80', label: _('Flash from'), range: [ 20, 500, 'ms' ] },
		{ opt: 'flash_max_ms', def: '300', label: _('Flash up to'), range: [ 300, 3000, 'ms' ] }
	] },
	{ title: _('Recording'), descr: _('Answered calls are kept on the router as WAV files, the oldest removed past the size limit. A recording may need the other side\'s consent where you live.'), rows: [
		{ opt: 'record_enabled', def: '0', label: _('Record calls'), choices: [ [ '1', _('On') ], [ '0', _('Off') ] ] },
		{ opt: 'record_max_mb', def: '50', label: _('Keep at most'), range: [ 1, 4095, 'MB' ] }
	] }
];

const ROWS = [].concat(...SETTINGS.map(s => s.rows));

function sameDay(a, b) {
	return a.getFullYear() == b.getFullYear() && a.getMonth() == b.getMonth() && a.getDate() == b.getDate();
}

function when(ts) {
	const d = new Date(ts * 1000), now = new Date();
	const clock = '%02d:%02d'.format(d.getHours(), d.getMinutes());

	if (sameDay(d, now))
		return clock;

	return d.toLocaleDateString(undefined, (d.getFullYear() == now.getFullYear())
		? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + clock;
}

function duration(s) {
	s = Math.max(0, s | 0);

	return (s >= 3600) ? '%d:%02d:%02d'.format(s / 3600 | 0, (s / 60 | 0) % 60, s % 60) : '%d:%02d'.format(s / 60 | 0, s % 60);
}

function b64bytes(b64) {
	const bin = atob(b64 || ''), out = new Uint8Array(bin.length);

	for (let i = 0; i < bin.length; i++)
		out[i] = bin.charCodeAt(i);

	return out;
}

// A whole WAV file of the daemon's, fetched chunk by chunk.
function fetchWav(get, name) {
	const parts = [];
	const next = offset => get(name, offset).then(r => {
		const bytes = b64bytes(r && r.b64);

		parts.push(bytes);

		if (r && r.more && bytes.length)
			return next(offset + bytes.length);

		return new Blob(parts, { type: 'audio/wav' });
	});

	return next(0);
}

// ---- the Call panel: the phone in the browser ----

const CALL_STATES = {
	disabled: [ _('Off'), '' ],
	idle: [ _('Idle'), 'good' ],
	outgoing_setup: [ _('Calling'), 'accent' ],
	early_media: [ _('Calling'), 'accent' ],
	incoming_ringing: [ _('Incoming call'), 'accent aw-ringing' ],
	active: [ _('In call'), 'accent' ],
	terminating: [ _('Ending'), '' ],
	recovering: [ _('Recovering'), 'warn' ],
	fault: [ _('Fault'), 'warn' ]
};

const OWNERS = { handset: _('the handset'), machine: _('the answering machine'), web: _('this page'), sip: _('a network phone') };

// The daemon's refusal words.
const REFUSALS = {
	'refused-busy': _('The line already has this call, or someone else answered it.'),
	'refused-nocall': _('There is no call for that.'),
	'refused-revision': _('The call moved on; try again.'),
	'refused-mode': _('Another program has the line.'),
	'refused-rate': _('The audio rate is not one the line carries.'),
	'refused-port': _('The voice port has another opener.'),
	'NOT_AVAILABLE': _('The line did not take the request: the number may be blocked, or the line is not ready.')
};

const PAD = [ [ '1', '' ], [ '2', 'ABC' ], [ '3', 'DEF' ], [ '4', 'GHI' ], [ '5', 'JKL' ], [ '6', 'MNO' ],
	[ '7', 'PQRS' ], [ '8', 'TUV' ], [ '9', 'WXYZ' ], [ '*', '' ], [ '0', '+' ], [ '#', '' ] ];

const DIAL_RE = /^\+?[0-9*#]{1,32}$/;

const refusal = w => REFUSALS[w] || (w ? _('The line refused (%s).').format(w) : _('The line did not take the request.'));

// call_status, normalised.
function callView(r) {
	const n = v => (typeof v == 'number' && isFinite(v)) ? v : 0;

	return {
		state: r.state || 'idle',
		number: r.remote_number || '',
		withheld: r.caller_id_withheld === true,
		duration: n(r.call_duration_seconds),
		revision: n(r.revision),
		owner: r.answer_owner || 'none',
		held: r.held === true,
		waiting: r.waiting === true
	};
}

function callPanel(view) {
	const p = {
		call: null,		// callView, or null while the service is off
		busy: false,		// an action is under way
		engine: null,		// the browser audio, while this page has it
		prep: null,		// prepare(): microphone and context, made in a click
		autoUntil: 0,		// a call placed or answered here starts its audio by itself until then
		audioBusy: false,
		reason: '',
		proxied: null,		// does the router carry the audio on this page's address
		trust: null,		// does the browser take the audio port's certificate
		probing: false,
		flashUntil: 0,
		readAt: 0
	};

	const pill = E('span', { 'class': 'aw-pill' });
	const dur = E('span', { 'class': 'aw-mono aw-muted' });
	const chips = E('div', { 'class': 'aw-row', 'style': 'gap:.4em;margin-top:.6em' });
	const input = E('input', { 'type': 'text', 'inputmode': 'tel', 'autocomplete': 'off', 'maxlength': 32,
		'placeholder': _('Number'), 'aria-label': _('Number to call') });
	const back = E('button', { 'class': 'aw-iconbtn', 'type': 'button', 'title': _('Delete the last digit') }, [ rf.icon('backspace', '1.2em') ]);
	const keys = PAD.map(([ d, l ]) => E('button', { 'class': 'aw-key', 'type': 'button', 'aria-label': d, 'click': () => press(d) },
		[ E('b', {}, [ d ]), E('small', {}, [ l ]) ]));
	const btn = cls => E('button', { 'class': 'btn cbi-button ' + cls, 'type': 'button' });
	const primary = btn('cbi-button-positive'), flash = btn('cbi-button-neutral'), secondary = btn('cbi-button-negative');
	const hint = E('div', { 'class': 'aw-note' });
	const err = E('div', { 'class': 'aw-note err', 'role': 'alert' });

	const audioText = E('div', { 'class': 'aw-note', 'style': 'flex:1 1 100%;margin:0' });
	const meter = E('div', { 'class': 'aw-meter', 'aria-hidden': 'true' }, [ E('div', { 'style': 'width:0' }) ]);
	const useBtn = E('button', { 'class': 'btn cbi-button cbi-button-action', 'type': 'button', 'click': () => manualAudio() },
		[ rf.icon('mic'), _('Use this computer') ]);
	const muteBtn = E('button', { 'class': 'btn cbi-button', 'type': 'button', 'click': () => {
		if (p.engine)
			p.engine.mute(!p.engine.muted);
		drawAudio();
	} });
	const stopBtn = E('button', { 'class': 'btn cbi-button', 'type': 'button', 'click': () => stopAudio('') }, [ _('Stop audio') ]);
	const trustBtn = E('button', { 'class': 'btn cbi-button', 'type': 'button', 'click': () => {
		const a = audioAddr();

		if (a) {
			p.trust = null;
			window.open(webphone.url(a.host, a.port), '_blank', 'noopener');
		}
	} }, [ _('Allow the audio port') ]);
	const audioRow = E('div', { 'class': 'aw-audio' }, [ audioText, useBtn, muteBtn, stopBtn, trustBtn, meter ]);

	const node = E('div', { 'class': 'cbi-section' }, [
		E('div', { 'class': 'aw-row' }, [ E('h3', { 'style': 'margin:0' }, [ _('Call') ]), pill, E('span', { 'class': 'aw-spacer' }), dur ]),
		chips,
		E('div', { 'class': 'aw-dialer' }, [
			E('div', {}, [ E('div', { 'class': 'aw-dial' }, [ input, back ]), E('div', { 'class': 'aw-pad' }, keys) ]),
			E('div', { 'class': 'aw-rail' }, [ primary, flash, secondary ])
		]),
		hint,
		err,
		audioRow
	]);

	const label = (b, icon, text) => {
		if (b.dataset.label != icon + text) {
			b.dataset.label = icon + text;
			dom.content(b, [ rf.icon(icon), text ]);
		}
	};

	const callish = c => c && (!(c.state == 'idle' || c.state == 'disabled') || c.held || c.waiting);

	// ---- actions ----

	const refresh = () => L.resolveDefault(callCallStatus(), null).then(r => {
		p.call = r ? callView(r) : null;
		p.readAt = Date.now();
		draw();
	});

	// One action at a time; a refusal is shown with its word, and the call
	// is read again either way (and once more a moment later, as the line
	// moves on).
	const act = (fn) => {
		if (p.busy)
			return;

		p.busy = true;
		err.textContent = '';
		draw();

		return fn().then(r => {
			if (!r || r.ok !== true)
				err.textContent = refusal(r && r.refused);
		}, e => {
			err.textContent = String(e.message || e);
		}).then(() => {
			p.busy = false;
			return refresh();
		}).then(() => setTimeout(refresh, 1200));
	};

	const press = d => {
		const c = p.call;

		if (!c || p.busy)
			return;

		if (c.state == 'active')
			act(() => callWebDtmf(d));
		else if (c.state == 'idle' && input.value.length < 32) {
			input.value += d;
			draw();
		}
	};

	const dial = () => {
		const n = input.value.replace(/[\s()-]/g, '');

		if (!DIAL_RE.test(n) || n == '*' || n == '#') {
			err.textContent = _('Enter a number: digits, * and #, with an optional leading +.');
			return;
		}

		prepareAudio(60000);
		act(() => callWebDial(n).then(r => {
			if (r && r.ok)
				input.value = '';
			return r;
		}));
	};

	primary.addEventListener('click', () => {
		const c = p.call;

		if (!c || p.busy)
			return;

		if (c.state == 'incoming_ringing') {
			prepareAudio(15000);
			act(() => callWebAnswer());
		}
		else if (c.state == 'idle')
			dial();
	});

	secondary.addEventListener('click', () => {
		const c = p.call;

		if (!c || p.busy)
			return;

		if (c.state == 'incoming_ringing')
			act(() => callWebReject());
		else if (c.owner == 'web')
			act(() => callWebHangup());
		else
			act(() => callHangup().then(() => ({ ok: true })));
	});

	flash.addEventListener('click', () => {
		if (!p.call || p.busy)
			return;

		p.flashUntil = Date.now() + 3000;	// keys within it are codes
		act(() => callWebFlash());
	});

	input.addEventListener('input', () => draw());
	input.addEventListener('keydown', ev => {
		if (ev.key == 'Enter') {
			ev.preventDefault();
			primary.click();
		}
	});
	back.addEventListener('click', () => {
		input.value = input.value.slice(0, -1);
		draw();
	});

	// ---- browser audio ----

	// Where the page reaches the daemon's audio listener, while it is up: on
	// this page's own address when the router's nginx carries it, else on the
	// listener's own port (an address on loopback is this router's too).
	const audioAddr = () => {
		const w = view.health && view.health.web;

		if (!w || !(w.audio == 'listening' || w.audio == 'connected') || !(w.port > 0) || p.proxied == null)
			return null;

		if (p.proxied)
			return { url: webphone.sameOrigin() };

		const host = (w.address && !/^127\./.test(w.address)) ? w.address : window.location.hostname;

		return { host: host, port: w.port };
	};

	webphone.proxied().then(ok => {
		p.proxied = ok;

		if (ok)
			p.trust = true;	// the page's own certificate

		drawAudio();
	});

	// Inside the click that places or answers a call: the microphone and a
	// running audio context, so the audio can start the moment the call
	// connects, however long that takes.
	const prepareAudio = ms => {
		if (!webphone.supported() || !audioAddr() || p.engine || p.trust === false)
			return;

		p.autoUntil = Date.now() + ms;
		p.autoFrom = Date.now();

		if (!p.prep) {
			p.prep = webphone.prepare();
			p.prep.catch(e => {
				p.prep = null;
				p.autoUntil = 0;
				p.reason = (e && e.name == 'NotAllowedError') ? _('The browser did not allow the microphone.') : String((e && e.message) || e);
				drawAudio();
			});
		}
	};

	const manualAudio = () => {
		p.autoUntil = 0;

		if (!p.prep)
			p.prep = webphone.prepare();

		startAudio();
	};

	const startAudio = () => {
		const c = p.call, a = audioAddr();

		if (p.audioBusy || p.engine || !c || c.state != 'active' || !a)
			return;

		const prep = p.prep;

		p.prep = null;
		p.audioBusy = true;
		p.reason = '';
		drawAudio();

		callWebAudio(c.revision).then(r => {
			if (!r || r.ok !== true) {
				webphone.release(prep);
				p.reason = refusal(r && r.refused);
				return;
			}

			return webphone.start({ url: a.url, host: a.host, port: r.port || a.port, token: r.token, prep: prep, onEvent: ev => {
				if (ev.type == 'level') {
					const bar = meter.firstChild;

					p.level = Math.max(ev.level, (p.level || 0) * 0.85);
					bar.style.width = Math.round(Math.min(1, p.level) * 100) + '%';
					return;
				}

				if (ev.type == 'closed' || ev.type == 'stopped') {
					p.engine = null;

					if (ev.type == 'closed')
						p.reason = _('The audio stream ended.');
				}

				drawAudio();
			} }).then(res => {
				if (res.ok) {
					p.engine = res.engine;
					p.trust = true;
				}
				else {
					p.reason = res.refused && res.refused != 'no-microphone' ? refusal(res.refused) : (res.reason || '');

					// no stream at all: ask the browser about the port again
					if (!res.refused && !a.url)
						p.trust = null;
				}
			});
		}, e => {
			webphone.release(prep);
			p.reason = String(e.message || e);
		}).then(() => {
			p.audioBusy = false;
			drawAudio();
		});
	};

	const stopAudio = reason => {
		const e = p.engine;

		p.engine = null;
		p.reason = reason;

		if (e)
			e.stop();

		drawAudio();
	};

	const probe = () => {
		const a = audioAddr();

		if (p.probing || !a || a.url || !webphone.supported())
			return;

		p.probing = true;
		webphone.probe(a.host, a.port).then(ok => {
			p.trust = ok;
			p.probing = false;
			drawAudio();
		});
	};

	// back from the tab where the certificate was accepted
	window.addEventListener('focus', () => {
		if (p.trust === false && node.isConnected)
			probe();
	});

	const drawAudio = () => {
		const c = p.call, a = audioAddr(), live = !!(p.engine && p.engine.live);
		const mine = !!(c && c.state == 'active' && c.owner == 'web');

		if (p.trust == null && a && !a.url && webphone.supported())
			probe();

		// a call placed or answered here starts its audio by itself
		if (p.autoUntil) {
			// the line takes a moment to leave idle after the click
			if (Date.now() > p.autoUntil || (!callish(c) && !p.busy && Date.now() - p.autoFrom > 4000)) {
				p.autoUntil = 0;
				webphone.release(p.prep);
				p.prep = null;
			}
			else if (mine && !p.engine && !p.audioBusy && a) {
				p.autoUntil = 0;
				startAudio();
			}
		}

		// the call left this page: the microphone goes with it
		if (p.engine && !mine)
			stopAudio(_('The call is no longer on this page.'));

		const trustStep = !!a && webphone.supported() && p.trust === false && !live;

		useBtn.hidden = !mine || !!p.engine || p.audioBusy || !a || !webphone.supported() || trustStep;
		muteBtn.hidden = stopBtn.hidden = !p.engine;
		muteBtn.disabled = !live;
		dom.content(muteBtn, (p.engine && p.engine.muted) ? [ rf.icon('mic'), _('Unmute') ] : [ rf.icon('micoff'), _('Mute') ]);
		trustBtn.hidden = !trustStep;
		meter.hidden = !live;

		let text;

		if (!webphone.supported())
			text = _('Calls from this page need the page over HTTPS and a browser with microphone access; the handset works as usual.');
		else if (!a && p.proxied == null)
			text = '';
		else if (!a)
			text = _('The phone service\'s audio listener is not up, so this page can control calls but not carry their audio.');
		else if (trustStep)
			text = _('This browser has not accepted the router\'s certificate for the audio port (%d) yet. Allow it once in the tab that opens, then come back.').format(a.port);
		else if (live)
			text = p.engine.muted ? _('This computer\'s microphone is muted.') : _('The call is on this computer\'s microphone and speaker.');
		else if (p.audioBusy)
			text = _('Opening the audio...');
		else if (p.reason)
			text = p.reason;
		else if (mine)
			text = _('This page has the call: use this computer\'s microphone and speaker for it.');
		else
			text = _('Calls placed or answered here use this computer\'s microphone and speaker. While this page has a call, the handset hears nothing.');

		audioText.textContent = text;
	};

	// ---- the page's own ring, while a call rings (and the bell is not held quiet) ----

	let ringCtx = null, ringTimer = 0;

	const beep = t => {
		const o = ringCtx.createOscillator(), g = ringCtx.createGain();

		o.frequency.value = 1000;
		o.connect(g).connect(ringCtx.destination);
		g.gain.setValueAtTime(0, t);
		g.gain.linearRampToValueAtTime(0.12, t + 0.02);
		g.gain.setValueAtTime(0.12, t + 0.38);
		g.gain.linearRampToValueAtTime(0, t + 0.4);
		o.start(t);
		o.stop(t + 0.42);
	};

	const ringOnce = () => {
		if (ringCtx && ringCtx.state == 'running' && node.isConnected) {
			beep(ringCtx.currentTime);
			beep(ringCtx.currentTime + 0.6);
		}
	};

	// a browser plays no sound before the page's first gesture
	const arm = () => {
		if (!ringCtx && window.AudioContext)
			ringCtx = new AudioContext();
		else if (ringCtx && ringCtx.state == 'suspended')
			ringCtx.resume();
	};

	document.addEventListener('pointerdown', arm, { once: true });
	document.addEventListener('keydown', arm, { once: true });

	const ring = on => {
		if (on && !ringTimer) {
			ringOnce();
			ringTimer = setInterval(ringOnce, 4000);
		}
		else if (!on && ringTimer) {
			clearInterval(ringTimer);
			ringTimer = 0;
		}
	};

	// ---- drawing ----

	const elapsed = () => {
		const c = p.call;

		return (c && c.state == 'active') ? c.duration + Math.max(0, (Date.now() - p.readAt) / 1000 | 0) : 0;
	};

	setInterval(() => {
		if (node.isConnected && p.call && p.call.state == 'active')
			dur.textContent = duration(elapsed());
	}, 1000);

	const draw = () => {
		const c = p.call, st = c ? c.state : 'disabled';
		const ringing = st == 'incoming_ringing', active = st == 'active';
		const s = CALL_STATES[st] || [ st, '' ];
		const chip = (text, cls) => E('span', { 'class': 'aw-pill ' + (cls || '') }, [ text ]);

		node.hidden = !c;

		pill.className = 'aw-pill ' + s[1];
		pill.textContent = c && c.held && st == 'idle' ? _('On hold') : s[0];
		dur.textContent = active ? duration(elapsed()) : '';

		const cs = [];

		if (c && callish(c)) {
			cs.push(chip(c.withheld ? _('Number withheld') : (c.number || _('Unknown number')), 'aw-mono'));

			if (OWNERS[c.owner])
				cs.push(chip(_('Answered on %s').format(OWNERS[c.owner])));
			if (c.held)
				cs.push(chip(_('A call is on hold'), 'warn'));
			if (c.waiting)
				cs.push(chip(_('A call is waiting'), 'warn'));
		}

		dom.content(chips, cs);
		chips.hidden = !cs.length;

		ring(ringing && !(view.status && view.status.quiet === true));

		if (ringing) {
			label(primary, 'callin', _('Answer'));
			label(secondary, 'callmissed', _('Reject'));
		}
		else {
			label(primary, 'phone', _('Call'));
			label(secondary, 'hangup', (st == 'outgoing_setup' || st == 'early_media') ? _('Cancel') : _('Hang up'));
		}

		label(flash, 'swap', _('Flash'));

		const live = !!c && !p.busy;

		primary.disabled = !live || !(ringing ? c.owner == 'none' : (st == 'idle' && !c.held && !c.waiting && !!input.value.trim()));
		secondary.disabled = !live || !(ringing || active || st == 'outgoing_setup' || st == 'early_media' || c.held || c.waiting);
		flash.disabled = !live || !(active || c.held || c.waiting);
		input.disabled = !live || callish(c);
		back.disabled = input.disabled || !input.value;
		keys.forEach(k => { k.disabled = !live || !(st == 'idle' || active); });

		if (!c)
			hint.textContent = '';
		else if (active && Date.now() < p.flashUntil)
			hint.textContent = _('After Flash: 1 ends this call and takes the other, 2 holds or swaps, 3 joins, 0 refuses the waiting call.');
		else if (c.held)
			hint.textContent = _('The call is on hold: Flash takes it back.');
		else if (c.waiting)
			hint.textContent = _('A second call is waiting: Flash takes it.');
		else if (active)
			hint.textContent = _('In a call, a key sends its tone.');
		else if (st == 'idle')
			hint.textContent = _('Type a number or use the keypad, then Call.');
		else
			hint.textContent = '';

		drawAudio();
	};

	draw();

	return {
		node: node,

		// a new call_status reply (or null: the service is off)
		update(r) {
			p.call = r ? callView(r) : null;
			p.readAt = Date.now();
			draw();
		},

		// whether a call is under way, for a quicker poll
		busy() {
			return !!(callish(p.call) || p.engine);
		}
	};
}

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.all([
			L.resolveDefault(callStatus(), null),
			L.resolveDefault(callCalls(), null),
			L.resolveDefault(callHealth(), null),
			uci.load(CONF).catch(() => null),
			L.resolveDefault(callCallStatus(), null)
		]);
	},

	opt(name, def) {
		const v = uci.get(CONF, SECT, name);

		return (v == null || v === '') ? def : String(v);
	},

	enabled() {
		return this.opt('enabled', '1') == '1';
	},

	// ---- status ----

	statusPane() {
		const st = this.status, h = this.health;
		const running = !!st;
		const stat = (label, value, title) => E('div', { 'class': 'aw-stat', 'title': title || null }, [
			E('small', {}, [ label ]), E('strong', {}, [ value ])
		]);
		let pill, body;

		if (!running && !this.enabled()) {
			pill = E('span', { 'class': 'aw-pill' }, [ _('Off') ]);
			body = E('div', { 'class': 'cbi-section-descr' }, [
				_('While the phone is on, it takes the modem\'s first AT port for its calls and lights the phone LED for the line. The modem pages then use the second AT port, and the phone LED no longer shows new messages.')
			]);
		}
		else if (!running) {
			pill = E('span', { 'class': 'aw-pill warn' }, [ _('Not running') ]);
			body = E('div', { 'class': 'alert-message warning' }, [
				_('The phone is switched on but its service is not running. The system log (tag awvoice) says why; turning it off and on again starts it anew.')
			]);
		}
		else {
			const s = STATES[st.state] || STATES.down;
			const vn = st.voiceNetwork || {}, sig = st.signal || {}, line = (h && h.line) || {};
			const stats = [
				stat(_('Handset'), st.hook == 'off' ? _('Lifted') : st.hook == 'on' ? _('On hook') : '-'),
				stat(_('Voice network'), vn.registered === true ? (vn.ims === true ? _('VoLTE') : _('Registered')) : vn.registered === false ? _('Not registered') : '-'),
				stat(_('Signal'), sig.rsrpDbm != null ? '%d dBm'.format(sig.rsrpDbm) : '-', sig.network || null),
				stat(_('Line voltage'), line.batteryMv != null ? '%.1f V'.format(line.batteryMv / 1000) : '-')
			];

			// the call itself is on the Call panel
			pill = E('span', { 'class': 'aw-pill ' + s[1] }, [ s[0] ]);
			body = E('div', { 'class': 'aw-stats' }, stats);
		}

		const on = running || this.enabled();

		return E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'aw-row' }, [
				E('h3', { 'style': 'margin:0' }, [ _('Line') ]),
				pill,
				E('span', { 'class': 'aw-spacer' }),
				E('button', {
					'class': 'btn cbi-button ' + (on ? 'cbi-button-neutral' : 'cbi-button-action'),
					'click': ui.createHandlerFn(this, 'power', !on)
				}, [ rf.icon('power'), on ? _('Turn off') : _('Turn on') ])
			]),
			E('div', { 'style': 'margin-top:.75em' }, [ body ])
		]);
	},

	power(on) {
		const go = () => {
			ui.showModal(on ? _('Turning the phone on') : _('Turning the phone off'), [ E('p', { 'class': 'spinning' }, [ _('Please wait...') ]) ]);

			return callPhone(on ? 'on' : 'off').catch(e => ({ code: 3, output: String(e.message || e) })).then(res => {
				ui.hideModal();

				if (res.code != 0)
					ui.addNotification(null, E('pre', { 'style': 'white-space:pre-wrap' }, [ res.output || _('The router did not answer.') ]), 'error');

				return this.reload();
			});
		};

		if (!on)
			return go();

		ui.showModal(_('Turn the phone on'), [
			E('p', {}, [ _('The phone service takes the modem\'s first AT port for its calls and drives the phone LED. The modem pages carry on over the second AT port, and the LED stops showing new messages while the phone is on.') ]),
			E('p', {}, [ _('The RJ11 contacts carry about 46 V, more while the phone rings. This is not certified telephone equipment: do not rely on it for emergency calls.') ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]), ' ',
				E('button', { 'class': 'btn cbi-button-action', 'click': go }, [ _('Turn on') ])
			])
		]);
	},

	// ---- call log ----

	callRow(c) {
		const miss = c.type == 'MISS';
		const icon = miss ? 'callmissed' : (c.type == 'OUT' ? 'callout' : 'callin');
		const res = RESULTS[c.result];
		const what = (c.type == 'OUT') ? _('Dialled') : miss ? _('Missed') : _('Received');
		const play = (kind, name) => {
			const btn = E('button', { 'class': 'aw-iconbtn', 'title': kind == 'msg' ? _('Play message') : _('Play recording') }, [ rf.icon(kind == 'msg' ? 'voicemail' : 'play') ]);

			btn.addEventListener('click', () => {
				btn.disabled = true;

				fetchWav((kind == 'msg') ? callMessage : callRecording, name).then(blob => {
					const audio = E('audio', { 'controls': '', 'autoplay': '', 'src': URL.createObjectURL(blob), 'style': 'height:2em;max-width:16em' });

					btn.replaceWith(audio);
				}).catch(e => {
					btn.disabled = false;
					ui.addNotification(null, E('p', {}, [ _('Could not load the file: %s').format(e.message || e) ]), 'error');
				});
			});

			return btn;
		};

		return E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td', 'style': 'width:2em', 'title': what }, [
				E('span', { 'style': miss ? 'color:var(--aw-danger)' : 'color:var(--aw-muted)' }, [ rf.icon(icon, '1.2em') ])
			]),
			E('td', { 'class': 'td' }, [
				E('div', { 'style': 'font-weight:600' + (miss ? ';color:var(--aw-danger)' : '') }, [ c.name || c.number || _('Unknown') ]),
				(c.name && c.number) ? E('small', { 'class': 'aw-muted aw-mono' }, [ c.number ]) : ''
			]),
			E('td', { 'class': 'td aw-muted', 'style': 'white-space:nowrap' }, [ when(c.ts) ]),
			E('td', { 'class': 'td', 'style': 'white-space:nowrap' }, [
				c.durationSec ? duration(c.durationSec) : (res && res != RESULTS.missed ? E('span', { 'class': 'aw-pill warn' }, [ res ]) : '')
			]),
			E('td', { 'class': 'td', 'style': 'text-align:right;white-space:nowrap' }, [
				c.message ? play('msg', c.message) : '',
				c.recording ? play('rec', c.recording) : ''
			])
		]);
	},

	callsPane() {
		const box = E('div');
		const seg = E('div', { 'class': 'aw-seg', 'role': 'group' }, FILTERS.map(([ value, label ]) =>
			E('button', { 'type': 'button', 'class': (this.filter == value) ? 'on' : '', 'click': ev => {
				this.filter = value;
				seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === ev.currentTarget));
				this.fillCalls();
			} }, [ label ])));

		this.callBox = box;
		this.fillCalls();

		return E('div', { 'class': 'cbi-section' }, [
			E('div', { 'class': 'aw-row' }, [
				E('h3', { 'class': 'aw-spacer', 'style': 'margin:0' }, [ _('Calls') ]),
				seg,
				E('button', { 'class': 'aw-iconbtn', 'title': _('Delete these calls'), 'disabled': !this.calls ? '' : null,
					'click': ui.createHandlerFn(this, 'clearCalls') }, [ rf.icon('trash') ])
			]),
			E('div', { 'style': 'margin-top:.5em' }, [ box ])
		]);
	},

	fillCalls() {
		if (!this.callBox)
			return;

		if (!this.calls) {
			dom.content(this.callBox, E('div', { 'class': 'aw-empty' }, [ _('The call log can be read while the phone is on.') ]));
			return;
		}

		const list = this.calls.filter(c => !this.filter || c.type == this.filter);

		if (!list.length) {
			dom.content(this.callBox, E('div', { 'class': 'aw-empty' }, [ rf.icon('phone', '2.5em'), E('p', {}, [ _('No calls yet.') ]) ]));
			return;
		}

		dom.content(this.callBox, E('table', { 'class': 'table' }, list.map(c => this.callRow(c))));
	},

	clearCalls() {
		const f = FILTERS.find(f => f[0] == this.filter);

		ui.showModal(_('Delete calls'), [
			E('p', {}, [ this.filter ? _('Delete every %s call from the log?').format(f[1].toLowerCase()) : _('Delete the whole call log?') ]),
			E('p', { 'class': 'aw-muted' }, [ _('Recordings and messages stay on the router.') ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]), ' ',
				E('button', { 'class': 'btn cbi-button-negative', 'click': () => {
					ui.hideModal();

					return L.resolveDefault(callCallsDelete(this.filter || undefined), null).then(() => this.loadCalls());
				} }, [ _('Delete') ])
			])
		]);
	},

	loadCalls() {
		return L.resolveDefault(callCalls(), null).then(r => {
			this.calls = (r && Array.isArray(r.calls)) ? r.calls : null;
			this.fillCalls();
		});
	},

	// ---- settings ----

	settingRow(row) {
		let ctl;

		if (row.choices) {
			ctl = E('div', { 'class': 'aw-seg', 'role': 'group' }, row.choices.map(([ value, label ]) =>
				E('button', { 'type': 'button', 'data-value': value, 'click': () => {
					this.want[row.opt] = value;
					this.update();
				} }, [ label ])));
		}
		else {
			ctl = E('span', { 'class': 'aw-row', 'style': 'gap:.4em' }, [
				E('input', { 'type': 'number', 'min': row.range[0], 'max': row.range[1], 'step': 1, 'style': 'width:7em',
					'value': this.want[row.opt], 'input': ev => {
						this.want[row.opt] = ev.target.value.trim();
						this.update();
					} }),
				E('span', { 'class': 'aw-muted' }, [ row.range[2] ])
			]);
		}

		this.controls[row.opt] = ctl;

		return E('div', { 'class': 'aw-row', 'style': 'align-items:flex-start' }, [
			E('div', { 'style': 'min-width:10em;max-width:14em;flex:0 0 12em;padding-top:.45em' }, [
				row.label, row.descr ? E('div', { 'class': 'aw-muted', 'style': 'font-size:.8em' }, [ row.descr ]) : ''
			]),
			ctl
		]);
	},

	settingsPane() {
		this.controls = {};
		this.have = {};
		ROWS.forEach(r => { this.have[r.opt] = this.opt(r.opt, r.def); });

		// the daemon takes "1"/"0" for ringback too
		if (this.have.ringback == '1') this.have.ringback = 'on';
		if (this.have.ringback == '0') this.have.ringback = 'off';

		this.want = Object.assign({}, this.have);

		this.barText = E('span', { 'class': 'aw-spacer' });
		this.bar = E('div', { 'class': 'aw-applybar', 'hidden': '' }, [
			this.barText,
			E('button', { 'class': 'btn cbi-button', 'click': () => {
				this.want = Object.assign({}, this.have);
				ROWS.forEach(r => {
					if (r.range)
						this.controls[r.opt].querySelector('input').value = this.want[r.opt];
				});
				this.update();
			} }, [ _('Undo') ]),
			E('button', { 'class': 'btn cbi-button cbi-button-apply', 'click': ui.createHandlerFn(this, 'save') }, [ _('Save') ])
		]);

		return E('div', {}, SETTINGS.map(s => E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ s.title ]),
			s.descr ? E('div', { 'class': 'cbi-section-descr' }, [ s.descr ]) : '',
			E('div', { 'class': 'aw-stack' }, s.rows.map(r => this.settingRow(r)))
		])).concat([ this.bar ]));
	},

	changed() {
		return ROWS.filter(r => String(this.want[r.opt]) != String(this.have[r.opt]));
	},

	invalid() {
		const bad = ROWS.filter(r => {
			if (!r.range)
				return false;

			const v = this.want[r.opt];

			return !/^\d+$/.test(v) || +v < r.range[0] || +v > r.range[1];
		}).map(r => '%s: %d-%d %s'.format(r.label, r.range[0], r.range[1], r.range[2]));

		if (!bad.length && +this.want.flash_max_ms < +this.want.flash_min_ms + 100)
			bad.push(_('Flash up to must be at least 100 ms above Flash from'));

		return bad;
	},

	update() {
		const n = this.changed().length;

		this.bar.hidden = !n;
		this.barText.textContent = (n == 1) ? _('1 change not saved') : _('%d changes not saved').format(n);

		ROWS.forEach(r => {
			if (r.choices)
				this.controls[r.opt].querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.value == this.want[r.opt]));
			else
				this.controls[r.opt].querySelector('input').classList.toggle('cbi-input-invalid', this.invalid().some(m => m.indexOf(r.label) == 0));
		});
	},

	save(confirmed) {
		const bad = this.invalid();

		if (bad.length) {
			ui.addNotification(null, E('p', {}, [ bad.join('; ') ]), 'warning');
			return Promise.resolve();
		}

		// The phone service applies HD voice by setting the modem's PCM
		// audio (AT+QDAI) and restarting the modem (AT+CFUN=1,1).
		if (this.status && confirmed !== true && this.changed().some(r => r.opt == 'hd')) {
			ui.showModal(_('Restart the modem?'), [
				E('p', {}, [ _('Changing HD voice sets the modem\'s audio interface and restarts the modem once the line is idle. Mobile data drops for about half a minute.') ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]), ' ',
					E('button', { 'class': 'btn cbi-button-action', 'click': () => {
						ui.hideModal();
						return this.save(true);
					} }, [ _('Save and restart') ])
				])
			]);
			return Promise.resolve();
		}

		if (uci.get(CONF, SECT) == null)
			uci.add(CONF, 'phone', SECT);

		this.changed().forEach(r => uci.set(CONF, SECT, r.opt, String(this.want[r.opt])));

		return uci.save()
			.then(() => callCommit(CONF))
			.then(() => this.status ? L.resolveDefault(callReload(), null) : null)
			.then(() => {
				ui.addTimeLimitedNotification(null, E('p', {}, [ this.status
					? _('Phone settings saved. The phone takes them when the line is idle.')
					: _('Phone settings saved. They apply when the phone is turned on.') ]), 5000, 'info');

				return this.reload();
			})
			.catch(e => ui.addNotification(null, E('p', {}, [ _('Could not save: %s').format(e.message || e) ]), 'error'));
	},

	// ---- page ----

	// What of a status marks a move of the call, to reload the call log on.
	callKey(st) {
		return st ? st.state + '|' + (st.call ? st.call.id + ':' + st.call.phase : '-') : 'off';
	},

	tick() {
		const root = this.root;

		if (document.visibilityState != 'visible' || !root.isConnected)
			return Promise.resolve();

		return Promise.all([
			L.resolveDefault(callStatus(), null),
			L.resolveDefault(callHealth(), null),
			L.resolveDefault(callCallStatus(), null)
		]).then(([ st, h, cs ]) => {
			// a reload (turning the phone on or off, a save) replaced the
			// page while this was under way: its answer may be older
			if (root !== this.root || !root.isConnected)
				return;

			const key = this.callKey(st);

			this.status = st;
			this.health = h;
			this.statusBox.replaceWith(this.statusBox = this.statusPane());
			this.panel.update(st ? cs : null);

			if (key != this.lastKey) {
				this.lastKey = key;
				return this.loadCalls();
			}
		});
	},

	reload() {
		uci.unload(CONF);

		return this.load().then(data => {
			const old = this.root;

			old.replaceWith(this.render(data));
		});
	},

	render([ st, calls, h, , cs ]) {
		this.status = st;
		this.health = h;
		this.calls = (calls && Array.isArray(calls.calls)) ? calls.calls : null;
		this.filter = this.filter || '';
		this.lastKey = this.callKey(st);
		this.statusBox = this.statusPane();

		// one Call panel for the view: a reload keeps its number and its audio
		this.panel = this.panel || callPanel(this);
		this.panel.update(st ? cs : null);

		this.root = E('div', { 'class': 'aw' }, [
			modem.css(),
			E('h2', {}, [ _('Phone') ]),
			this.statusBox,
			this.panel.node,
			this.callsPane(),
			this.settingsPane()
		]);

		this.update();

		// One poll per page on screen. Footstrap swaps pages without a
		// reload and may render this view again, so a poll whose page was
		// on screen and has left the document removes itself.
		const root = this.root;
		let shown = false;
		const fn = () => {
			if (root.isConnected)
				shown = true;
			else if (shown) {
				poll.remove(fn);
				return Promise.resolve();
			}

			return this.tick();
		};

		if (this.pollFn)
			poll.remove(this.pollFn);

		this.pollFn = fn;
		poll.add(fn, 2);

		return this.root;
	}
});
