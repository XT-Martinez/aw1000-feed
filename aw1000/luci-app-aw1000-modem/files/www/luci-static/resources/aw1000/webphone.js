// SPDX-License-Identifier: GPL-2.0-only
// Copyright (C) 2026 Pr0Luci (awvoice: audio.js)
// Copyright (C) 2026 XT-Martinez
'use strict';
'require baseclass';

// The Phone page's browser audio: the call's voice to this computer's
// speaker and its microphone to the line, over awvoice's encrypted
// WebSocket (web_proto.h): on the page's own address at /awvoice/audio when
// the router's nginx carries it (proxied()), else wss://<router>:<web_port>/audio.
//
// Frames: a 12-byte header (magic 0x41, version 1, type, 0, seq and
// timestamp as big-endian u32) and a payload. HELLO carries the single-use
// token from web_audio_open, GRANT the daemon's verdict ("granted" or a
// refusal word), PCM 320 bytes (20 ms, 8 kHz, S16BE), MUTE one byte, BYE.
//
// start() resolves { ok, refused, reason, engine }; it never rejects.

const HDR = 12, MAGIC = 0x41, VERSION = 1;
const T_HELLO = 1, T_GRANT = 2, T_PCM = 3, T_MUTE = 4, T_BYE = 5;
const PCM_BYTES = 320;

function frame(type, seq, payload) {
	const out = new Uint8Array(HDR + (payload ? payload.length : 0));
	const dv = new DataView(out.buffer);

	out[0] = MAGIC;
	out[1] = VERSION;
	out[2] = type;
	dv.setUint32(4, seq >>> 0);
	dv.setUint32(8, (seq * 20) >>> 0);

	if (payload)
		out.set(payload, HDR);

	return out;
}

const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0) & 0x7f);

return baseclass.extend({
	// A secure page, a microphone, AudioWorklet and WebSocket.
	supported() {
		return !!(window.isSecureContext && window.AudioContext && window.AudioWorkletNode && window.WebSocket &&
			navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
	},

	url(host, port, path) {
		return '%s://%s:%d/%s'.format(path == null ? 'https' : 'wss', host.indexOf(':') >= 0 ? '[' + host + ']' : host, port, path || '');
	},

	// Whether the router's web server carries the audio on this page's own
	// address (aw1000.locations answers /awvoice/ping). Resolves true or false.
	proxied() {
		return window.fetch('/awvoice/ping', { cache: 'no-store', credentials: 'omit' })
			.then(r => r.status == 204, () => false);
	},

	// The audio on this page's own address.
	sameOrigin() {
		return 'wss://' + window.location.host + '/awvoice/audio';
	},

	// Whether this browser takes the audio port's certificate: a request
	// there completes only if it does. Resolves true or false.
	probe(host, port) {
		return window.fetch(this.url(host, port), { mode: 'no-cors', cache: 'no-store' }).then(() => true, () => false);
	},

	// The microphone and a running audio context with the worklet loaded.
	// Call it from a click: the context is made at once, while the click
	// still allows sound, then the browser is asked for the microphone.
	// Every browser treatment is off: its gain control boosts into the clip,
	// its echo and noise handling makes speech sound processed, and the
	// worklet levels the send side itself. Resolves { ac, stream }.
	prepare() {
		let ac;

		try {
			ac = new AudioContext({ latencyHint: 'interactive' });
		}
		catch (e) {
			return Promise.reject(e);
		}

		ac.resume().catch(() => {});

		return ac.audioWorklet.addModule(L.resource('aw1000/webphone-worklet.js') + '?v=' + (L.env.resource_version || ''))
			.then(() => navigator.mediaDevices.getUserMedia({ audio: {
				echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1
			} }))
			.then(stream => ({ ac: ac, stream: stream }), e => {
				ac.close().catch(() => {});
				throw e;
			});
	},

	// Gives back what prepare() made, for a call that never connected.
	release(prep) {
		if (prep)
			prep.then(p => {
				p.stream.getTracks().forEach(t => t.stop());
				p.ac.close().catch(() => {});
			}, () => {});
	},

	// opts: { url | host and port, token, prep, onEvent }; prep is a prepare()
	// promise, which start() then owns. Events: { type: 'live' |
	// 'level' (level 0..1) | 'closed' | 'stopped' }.
	start(opts) {
		const engine = { live: false, muted: false };
		const emit = ev => opts.onEvent && opts.onEvent(ev);
		let ws = null, ac = null, stream = null, capture = null, player = null;
		let seq = 0, settled = false, timer = null, resolve;

		const send = (type, payload) => {
			if (ws && ws.readyState === 1)
				try { ws.send(frame(type, seq, payload)); } catch (e) { /* the close handler takes over */ }
		};

		const cleanup = () => {
			if (ws) {
				send(T_BYE, ascii('bye'));
				try { ws.close(); } catch (e) { }
				ws = null;
			}

			engine.live = false;

			if (stream)
				stream.getTracks().forEach(t => t.stop());

			if (ac)
				ac.close().catch(() => {});

			stream = ac = capture = player = null;
		};

		const settle = res => {
			if (settled)
				return;

			settled = true;
			clearTimeout(timer);

			if (!res.ok) {
				// a microphone made for this call but never taken goes back
				if (opts.prep && !ac)
					this.release(opts.prep);

				cleanup();
			}

			res.engine = engine;
			resolve(res);
		};

		// The microphone and the audio context, made beforehand by
		// prepare() (inside the click that placed or answered the call), or
		// here.
		const beginAudio = () => (opts.prep || this.prepare()).then(p => {
			stream = p.stream;
			ac = p.ac;

			const mute = ac.createGain();

			capture = new AudioWorkletNode(ac, 'aw-capture', { numberOfOutputs: 1, outputChannelCount: [ 1 ] });
			player = new AudioWorkletNode(ac, 'aw-player', { numberOfInputs: 0, outputChannelCount: [ 1 ] });

			// the capture node runs only while connected to the output:
			// through a gain of 0, so the microphone is not heard locally
			mute.gain.value = 0;
			ac.createMediaStreamSource(stream).connect(capture);
			capture.connect(mute).connect(ac.destination);
			player.connect(ac.destination);

			capture.port.onmessage = e => {
				const d = e.data;

				emit({ type: 'level', level: d.level });

				if (engine.live && !engine.muted && d.pcm && d.pcm.byteLength === PCM_BYTES) {
					send(T_PCM, new Uint8Array(d.pcm));
					seq++;
				}
			};

			engine.live = true;
			emit({ type: 'live' });

			return ac.resume().catch(() => {});
		});

		const onMessage = msg => {
			const buf = msg.data;

			if (!(buf instanceof ArrayBuffer) || buf.byteLength < HDR)
				return;

			const head = new Uint8Array(buf, 0, 3);

			if (head[0] !== MAGIC || head[1] !== VERSION)
				return;

			if (head[2] === T_PCM) {
				if (player && buf.byteLength === HDR + PCM_BYTES) {
					const pcm = buf.slice(HDR);

					player.port.postMessage(pcm, [ pcm ]);
				}
				return;
			}

			if (head[2] !== T_GRANT || settled)
				return;

			const verdict = String.fromCharCode.apply(null, new Uint8Array(buf, HDR));

			if (verdict !== 'granted')
				return settle({ ok: false, refused: verdict, reason: null });

			clearTimeout(timer);

			beginAudio().then(() => settle({ ok: true, refused: null, reason: null }), e => settle({
				ok: false, refused: 'no-microphone',
				reason: (e && e.name === 'NotAllowedError') ? _('The browser did not allow the microphone.')
					: (e && e.message) || _('The microphone could not be opened.')
			}));
		};

		engine.mute = on => {
			engine.muted = !!on;
			send(T_MUTE, Uint8Array.of(engine.muted ? 1 : 0));
			return engine.muted;
		};

		engine.stop = () => {
			const was = settled;

			settled = true;
			clearTimeout(timer);

			if (opts.prep && !ac)
				this.release(opts.prep);

			cleanup();

			if (!was)
				resolve({ ok: false, refused: null, reason: null, engine: engine });

			emit({ type: 'stopped' });
		};

		return new Promise(ok => {
			resolve = ok;

			try {
				ws = new WebSocket(opts.url || this.url(opts.host, opts.port, 'audio'));
			}
			catch (e) {
				return settle({ ok: false, refused: null, reason: String(e.message || e) });
			}

			ws.binaryType = 'arraybuffer';
			ws.onopen = () => send(T_HELLO, ascii(opts.token));
			ws.onmessage = onMessage;
			ws.onerror = () => settle({ ok: false, refused: null, reason: _('The secure audio stream could not be opened.') });
			ws.onclose = () => {
				if (!settled)
					return settle({ ok: false, refused: null, reason: _('The audio stream closed before it was granted.') });

				if (engine.live || ws) {
					cleanup();
					emit({ type: 'closed' });
				}
			};

			timer = setTimeout(() => settle({ ok: false, refused: null, reason: _('The audio stream did not answer.') }), 10000);
		});
	}
});
