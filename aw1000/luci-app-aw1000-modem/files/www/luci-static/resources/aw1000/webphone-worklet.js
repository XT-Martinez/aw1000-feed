// SPDX-License-Identifier: GPL-2.0-only
// Copyright (C) 2026 Pr0Luci (awvoice: audio-level.js, audio-worklet.js)
// Copyright (C) 2026 XT-Martinez (one module, direct S16BE packing)
//
// The Phone page's browser audio, as AudioWorklet processors. Plain
// worklet code (no LuCI); webphone.js loads it with audioWorklet.addModule.
// The stream is awvoice's web audio: 20 ms frames of 160 S16BE samples at
// 8 kHz, both ways.
//
// aw-capture: the microphone at the context's rate, low-passed at 3.4 kHz,
// levelled (the send level below), and resampled to 8 kHz by linear
// interpolation; every 160 samples it posts one frame and its peak.
// aw-player: frames into a jitter queue (three frames to start), linearly
// interpolated up to the context's rate; an empty queue is silence.

// ---- send level (awvoice audio-level.js, unchanged values) ----
// The browser's own gain control is off for this stream: it lifted a
// -20 dBFS tone to -0.2 dBFS on a live call. One slow loop holds a talker
// near -20 dBFS (at most +18 dB, at least -12 dB, not below -54 dBFS), and a
// 5 ms look-ahead ceiling keeps every sample under -3 dBFS.
const TARGET = 0.1, CEILING = 0.707, GAIN_MIN = 0.25, GAIN_MAX = 8, FLOOR = 0.002;
const RELEASE = 0.06, LOOKAHEAD = 0.005, SLOW = 3;

class Level {
	constructor(fs) {
		this.kUp = Math.exp(-1 / (fs * RELEASE));
		this.kSlew = 1 - Math.exp(-1 / (fs * SLOW));
		this.delay = new Float32Array(Math.ceil(fs * LOOKAHEAD) || 1);
		this.at = 0;
		this.slow = 0;
		this.gain = 1;
		// a monotonic queue of the magnitudes inside the delay line: the
		// largest at the front, so the ceiling reads the window's peak in O(1)
		this.win = this.delay.length + 1;
		this.slot = this.win + 1;
		this.mags = new Float32Array(this.slot);
		this.nos = new Int32Array(this.slot);
		this.front = 0;
		this.back = 0;
		this.seen = 0;
	}

	step(x) {
		const a = x < 0 ? -x : x, slot = this.slot;

		this.slow += (a - this.slow) * this.kSlew * (a > this.slow ? 1 : 0.25);

		while (this.back !== this.front && this.nos[this.front] <= this.seen - this.win)
			this.front = (this.front + 1) % slot;
		while (this.back !== this.front && this.mags[(this.back + slot - 1) % slot] <= a)
			this.back = (this.back + slot - 1) % slot;
		this.mags[this.back] = a;
		this.nos[this.back] = this.seen++;
		this.back = (this.back + 1) % slot;

		const top = this.mags[this.front];
		let want = this.slow > FLOOR ? TARGET / this.slow : 1;

		want = Math.min(GAIN_MAX, Math.max(GAIN_MIN, want));

		const gain = Math.min(want, CEILING / (top > 0.0001 ? top : 0.0001));

		this.gain = gain < this.gain ? gain : this.kUp * this.gain + (1 - this.kUp) * gain;

		const out = this.delay[this.at];

		this.delay[this.at] = x;
		this.at = (this.at + 1) % this.delay.length;

		return out * this.gain;
	}
}

// RBJ biquad low-pass, Q = 1/sqrt(2)
function lowpass(fs, fc) {
	const w0 = 2 * Math.PI * fc / fs, cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.SQRT1_2), a0 = 1 + alpha;

	return { b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, b2: (1 - cos) / 2 / a0, a1: -2 * cos / a0, a2: (1 - alpha) / a0 };
}

const FRAME = 160;

class Capture extends AudioWorkletProcessor {
	constructor() {
		super();
		this.step = sampleRate / 8000;	// input samples per output sample
		this.c = sampleRate > 8000 ? lowpass(sampleRate, 3400) : null;
		this.level = new Level(sampleRate);
		this.x1 = this.x2 = this.y1 = this.y2 = 0;
		this.prev = 0;			// the sample before the current one
		this.pos = 0;			// where the next output sample falls, from prev
		this.frame = new Uint8Array(FRAME * 2);
		this.n = 0;
		this.peak = 0;
	}

	filter(s) {
		const c = this.c;

		if (!c)
			return s;

		const y = c.b0 * s + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;

		this.x2 = this.x1; this.x1 = s;
		this.y2 = this.y1; this.y1 = y;

		return y;
	}

	emit(v) {
		const s = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
		const i = this.n++ * 2;

		this.frame[i] = (s >> 8) & 0xff;	// S16BE, the stream's order
		this.frame[i + 1] = s & 0xff;
		this.peak = Math.max(this.peak, s < 0 ? -s : s);

		if (this.n == FRAME) {
			const buf = this.frame.buffer;

			this.port.postMessage({ pcm: buf, level: this.peak / 32768 }, [ buf ]);
			this.frame = new Uint8Array(FRAME * 2);
			this.n = 0;
			this.peak = 0;
		}
	}

	process(inputs) {
		const ch = inputs[0] && inputs[0][0];

		if (!ch)
			return true;

		for (let i = 0; i < ch.length; i++) {
			const cur = this.level.step(this.filter(ch[i]));

			// output samples between prev (0) and cur (1)
			while (this.pos <= 1) {
				this.emit(this.prev + (cur - this.prev) * this.pos);
				this.pos += this.step;
			}

			this.pos -= 1;
			this.prev = cur;
		}

		return true;
	}
}

class Player extends AudioWorkletProcessor {
	constructor() {
		super();
		this.step = 8000 / sampleRate;
		this.ring = new Float32Array(2048);	// ~0.25 s of 8 kHz speech
		this.head = 0;
		this.tail = 0;
		this.pos = 0;
		this.playing = false;
		this.port.onmessage = e => {
			const b = new Uint8Array(e.data), mask = this.ring.length - 1;

			for (let k = 0; k + 1 < b.length; k += 2) {
				if (this.tail - this.head >= this.ring.length)
					this.head++;	// the far end outran the speaker: drop the oldest
				this.ring[this.tail++ & mask] = ((b[k] << 24 >> 16) | b[k + 1]) / 32768;
			}

			if (!this.playing && this.tail - this.head >= 3 * FRAME)
				this.playing = true;
		};
	}

	process(inputs, outputs) {
		const out = outputs[0] && outputs[0][0], mask = this.ring.length - 1;

		if (!out)
			return true;

		for (let i = 0; i < out.length; i++) {
			if (!this.playing || this.head >= this.tail) {
				this.playing = false;
				out[i] = 0;
				continue;
			}

			const a = this.ring[this.head & mask];
			const b = this.head + 1 < this.tail ? this.ring[(this.head + 1) & mask] : a;

			out[i] = a + (b - a) * this.pos;
			this.pos += this.step;

			while (this.pos >= 1 && this.head < this.tail) {
				this.head++;
				this.pos -= 1;
			}
		}

		// the same output on every channel the node has
		for (let c = 1; c < outputs[0].length; c++)
			outputs[0][c].set(out);

		return true;
	}
}

registerProcessor('aw-capture', Capture);
registerProcessor('aw-player', Player);
