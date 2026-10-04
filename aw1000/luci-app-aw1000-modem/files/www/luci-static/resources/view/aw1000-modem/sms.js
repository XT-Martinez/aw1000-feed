'use strict';
'require view';
'require ui';
'require poll';
'require aw1000.modem as modem';
'require aw1000.cell as rf';

// SMS as conversations: the messages in the modem's and the SIM's memory,
// the parts of long ones put back together, and the ones sent from here
// (which the backend keeps, as the modem does not).
//
// What was read is remembered in this browser (localStorage): a
// conversation shows as unread when it has a message newer than the last
// time it was open here.

const READ_KEY = 'aw1000-sms-read';

// GSM 03.38: the default alphabet, and the extension table's characters,
// which take two septets each.
const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€\f';

// "2024-02-26T17:13:01", the modem's local time, as a Date.
function parseTime(ts) {
	const m = (ts || '').match(/^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/);

	return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : new Date(0);
}

function sameDay(a, b) {
	return a.getFullYear() == b.getFullYear() && a.getMonth() == b.getMonth() && a.getDate() == b.getDate();
}

function clock(d) {
	return '%02d:%02d'.format(d.getHours(), d.getMinutes());
}

function shortDate(d) {
	const now = new Date();

	if (sameDay(d, now))
		return clock(d);

	return d.toLocaleDateString(undefined, (d.getFullYear() == now.getFullYear())
		? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

function dayLabel(d) {
	const now = new Date(), y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

	if (sameDay(d, now))
		return _('Today');

	if (sameDay(d, y))
		return _('Yesterday');

	return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}

// A phone number, whatever its prefix (+63 917..., 0917...), by its last
// ten digits; a sender name as itself.
function convKey(addr) {
	const s = (addr || '').trim();

	if (/^\+?[\d\s-]+$/.test(s) && s.replace(/\D/g, '').length >= 7)
		return s.replace(/\D/g, '').slice(-10);

	return s.toLowerCase();
}

// Received messages give international numbers without their "+".
function display(addr) {
	return /^\d{11,}$/.test(addr || '') ? '+' + addr : (addr || '');
}

function canReply(addr) {
	return /^\+?\d{3,}$/.test((addr || '').replace(/[\s-]/g, ''));
}

// [ characters used, characters per message, messages ].
function smsCount(text) {
	let n = 0, gsm = true;

	for (const ch of text) {
		if (GSM7.includes(ch))
			n++;
		else if (GSM7_EXT.includes(ch))
			n += 2;
		else {
			gsm = false;
			break;
		}
	}

	if (!gsm) {
		n = text.length;	// UTF-16 units, as UCS-2 counts them
		return [ n, n <= 70 ? 70 : 67, n <= 70 ? 1 : Math.ceil(n / 67) ];
	}

	return [ n, n <= 160 ? 160 : 153, n <= 160 ? 1 : Math.ceil(n / 153) ];
}

function hue(key) {
	let h = 0;

	for (const ch of key)
		h = (h * 31 + ch.codePointAt(0)) % 360;

	return h;
}

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return modem.smsList().catch(err => ({ error: String(err.message || err), received: [], sent: [] }));
	},

	readMap() {
		try {
			return JSON.parse(window.localStorage.getItem(READ_KEY));
		}
		catch (e) {
			return null;
		}
	},

	markRead(conv) {
		const map = this.readMap() || {};

		map[conv.key] = Math.max(map[conv.key] || 0, conv.last.time.getTime());

		try {
			window.localStorage.setItem(READ_KEY, JSON.stringify(map));
		}
		catch (e) {}
	},

	// Conversations from the backend's lists, newest first.
	conversations(data) {
		const convs = {};
		const parts = {};
		const conv = addr => {
			const key = convKey(addr);

			return convs[key] = convs[key] || { key: key, addr: addr, msgs: [] };
		};

		(data.received || []).forEach(m => {
			const id = m.storage + ':' + m.index;

			// The parts of one long message share sender, reference and total.
			if (m.total > 1) {
				const k = [ m.sender, m.reference, m.total ].join('|');

				if (!parts[k]) {
					parts[k] = { dir: 'in', addr: m.sender, time: parseTime(m.timestamp), parts: [], total: m.total, ids: [] };
					conv(m.sender).msgs.push(parts[k]);
				}

				parts[k].parts[m.part - 1] = m.content;
				parts[k].ids.push(id);

				if (m.part == 1)
					parts[k].time = parseTime(m.timestamp);
			}
			else {
				conv(m.sender).msgs.push({ dir: 'in', addr: m.sender, time: parseTime(m.timestamp), text: m.content || '', ids: [ id ] });
			}
		});

		Object.values(parts).forEach(p => {
			const missing = [];

			for (let i = 0; i < p.total; i++)
				if (p.parts[i] == null)
					missing.push(i + 1);

			p.text = p.parts.filter(t => t != null).join('') +
				(missing.length ? '\n' + _('[part %s of %d not received]').format(missing.join(', '), p.total) : '');
		});

		(data.sent || []).forEach(m => {
			conv(m.number).msgs.push({ dir: 'out', addr: m.number, time: parseTime(m.timestamp), text: m.content || '', ids: [ 'sent:' + m.id ] });
		});

		const read = this.readMap();
		const first = (read == null);

		return Object.values(convs).map(c => {
			c.msgs.sort((a, b) => a.time - b.time);
			c.last = c.msgs[c.msgs.length - 1];
			// The latest incoming address is the one to reply to.
			c.addr = (c.msgs.slice().reverse().find(m => m.dir == 'in') || c.last).addr;
			c.unread = !first && c.msgs.some(m => m.dir == 'in' && m.time.getTime() > ((read || {})[c.key] || 0));

			if (first)
				this.markRead(c);

			return c;
		}).sort((a, b) => b.last.time - a.last.time);
	},

	// A bar per message memory in +CPMS, "Modem 1 / 127" on each.
	storageBars(cpms) {
		const f = (cpms || '').replace(/^\+CPMS:\s*/, '').replace(/"/g, '').split(',');
		const names = { ME: _('Modem'), SM: _('SIM'), MT: _('Modem + SIM') };
		const seen = {}, out = [];

		for (let i = 0; i + 2 < f.length; i += 3) {
			const used = +f[i + 1], total = +f[i + 2];

			if (seen[f[i]] || !names[f[i]] || !total)
				continue;

			seen[f[i]] = true;
			out.push(E('div', { 'class': 'aw-store' }, [
				E('span', {}, [ names[f[i]] ]),
				E('span', {}, [ _('%d of %d').format(used, total) ]),
				E('div', { 'class': 'aw-meter', 'role': 'meter', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': used,
					'aria-label': names[f[i]] }, [
					E('div', { 'style': 'width:%.1f%%'.format(Math.min(100, 100 * used / total)) })
				])
			]));
		}

		return out;
	},

	avatar(c) {
		const style = 'background:hsl(%d,45%%,48%%)'.format(hue(c.key));

		if (canReply(c.addr))
			return E('div', { 'class': 'aw-avatar', 'style': style }, [ rf.icon('chat') ]);

		return E('div', { 'class': 'aw-avatar', 'style': style }, [ c.addr.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() ]);
	},

	renderList() {
		const q = this.search.value.trim().toLowerCase();
		const list = this.convs.filter(c => !q || display(c.addr).toLowerCase().includes(q) || c.msgs.some(m => m.text.toLowerCase().includes(q)));

		if (!list.length)
			return [ E('div', { 'class': 'aw-empty' }, [ q ? _('Nothing matches.') : _('No messages.') ]) ];

		return list.map(c => E('div', {
			'class': 'aw-conv' + (c.key == this.current ? ' active' : '') + (c.unread ? ' unread' : ''),
			'role': 'button', 'tabindex': '0',
			'click': () => this.open(c.key),
			'keydown': ev => { if (ev.key == 'Enter') this.open(c.key); }
		}, [
			this.avatar(c),
			E('div', { 'class': 'aw-conv-main' }, [
				E('div', { 'class': 'aw-conv-top' }, [
					E('span', { 'class': 'aw-conv-name' }, [ display(c.addr) ]),
					E('span', { 'class': 'aw-conv-time' }, [ shortDate(c.last.time) ])
				]),
				E('div', { 'class': 'aw-conv-top' }, [
					E('span', { 'class': 'aw-conv-snippet', 'style': 'flex:1' }, [ (c.last.dir == 'out' ? _('You: ') : '') + c.last.text.replace(/\s+/g, ' ') ]),
					c.unread ? E('span', { 'class': 'aw-dot', 'title': _('Unread') }) : ''
				])
			])
		]));
	},

	renderThread() {
		const c = this.convs.find(c => c.key == this.current);
		const isNew = (this.current == 'new');
		const head = [ E('button', { 'class': 'aw-iconbtn aw-back', 'title': _('Back'), 'click': () => this.open(null) }, [ rf.icon('back') ]) ];

		if (!c && !isNew) {
			this.composer.hidden = true;
			this.headBox.hidden = true;
			return [ E('div', { 'class': 'aw-empty', 'style': 'margin:auto' }, [
				rf.icon('chat', '3em'), E('p', {}, [ _('Choose a conversation, or start a new one.') ])
			]) ];
		}

		this.composer.hidden = false;
		this.headBox.hidden = false;

		if (isNew) {
			head.push(this.to);
		}
		else {
			head.push(
				this.avatar(c),
				E('div', { 'class': 'aw-title' }, [
					E('b', {}, [ display(c.addr) ]),
					E('small', {}, [ c.msgs.length == 1 ? _('1 message') : _('%d messages').format(c.msgs.length) ])
				]),
				E('button', { 'class': 'aw-iconbtn', 'title': _('Delete conversation'), 'click': () => this.remove(c.msgs, true) }, [ rf.icon('trash') ])
			);
		}

		const msgs = [];
		let day = null;

		(c ? c.msgs : []).concat(this.pending.filter(p => c && convKey(p.addr) == c.key)).forEach(m => {
			if (!day || !sameDay(day, m.time)) {
				day = m.time;
				msgs.push(E('div', { 'class': 'aw-day' }, [ dayLabel(m.time) ]));
			}

			msgs.push(E('div', { 'class': 'aw-bubble ' + m.dir + (m.state ? ' ' + m.state : ''), 'title': m.error || null }, [
				m.text,
				E('span', { 'class': 'aw-meta' }, [ m.state == 'pending' ? _('Sending...') : m.state == 'failed' ? _('Not sent') : clock(m.time) ]),
				m.ids ? E('button', { 'class': 'aw-iconbtn aw-del', 'title': _('Delete message'), 'click': () => this.remove([ m ]) }, [ rf.icon('trash') ]) : ''
			]));
		});

		const reply = isNew || (c && canReply(c.addr));

		this.text.disabled = !reply;
		this.text.placeholder = reply ? _('Message') : _('This sender does not take replies');
		this.updateCount();

		// The header only when it changes: it may hold the number being typed.
		const headKey = this.current + '|' + (c ? c.msgs.length + c.addr : '');

		if (this.headFor != headKey) {
			this.headFor = headKey;
			this.headBox.replaceChildren(...head);
		}

		return msgs;
	},

	draw(keepScroll) {
		const msgs = this.msgsBox;
		const atEnd = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
		const top = msgs.scrollTop;

		this.listBox.replaceChildren(...this.renderList());
		msgs.replaceChildren(...this.renderThread());
		this.root.classList.toggle('open', this.current != null);
		this.footText.replaceChildren(...this.storage);

		if (this.incoming && document.activeElement != this.where)
			this.where.value = this.incoming;
		msgs.scrollTop = (keepScroll && !atEnd) ? top : msgs.scrollHeight;
	},

	open(key) {
		this.current = key;

		const c = this.convs.find(c => c.key == key);

		if (c) {
			this.markRead(c);
			c.unread = false;
		}

		this.draw();

		if (key == 'new')
			this.to.focus();
		else if (c && !this.text.disabled)
			this.text.focus();
	},

	reload(keepScroll) {
		return this.load().then(data => {
			this.apply(data);
			this.draw(keepScroll);
		});
	},

	apply(data) {
		if (data.error)
			ui.addTimeLimitedNotification(null, E('p', {}, [ _('Could not read the messages: %s').format(data.error) ]), 8000, 'warning');

		this.convs = this.conversations(data);
		this.storage = this.storageBars(data.storage);
		// +CPMS: <mem1>,<used>,<total>,<mem2>,...,<mem3>,...: mem3 takes new messages.
		this.incoming = (data.storage || '').replace(/"/g, '').split(',')[6] || null;

		// An open conversation stays read while new messages come in.
		const c = this.convs.find(c => c.key == this.current);

		if (c && document.visibilityState == 'visible') {
			this.markRead(c);
			c.unread = false;
		}
	},

	updateCount() {
		const [ n, per, parts ] = smsCount(this.text.value);

		this.count.textContent = n ? _('%d / %d · %d SMS').format(n, per * parts, parts) : '';
		this.count.classList.toggle('over', parts > 1);
		this.sendBtn.disabled = this.text.disabled || !this.text.value.trim() ||
			(this.current == 'new' && !canReply(this.to.value));

		this.text.style.height = 'auto';
		this.text.style.height = Math.min(this.text.scrollHeight + 2, 150) + 'px';
	},

	send() {
		const c = this.convs.find(c => c.key == this.current);
		const number = ((this.current == 'new') ? this.to.value : c ? c.addr : '').replace(/[\s-]/g, '');
		const text = this.text.value;

		if (!canReply(number) || !text.trim())
			return;

		const p = { dir: 'out', addr: number, time: new Date(), text: text, state: 'pending' };

		this.pending.push(p);
		this.text.value = '';
		this.to.value = '';

		if (this.current == 'new') {
			const key = convKey(number);

			if (!this.convs.find(c => c.key == key))
				this.convs.unshift({ key: key, addr: number, msgs: [], last: p });

			this.current = key;
		}

		this.draw();

		return modem.smsSend(number, text).then(res => {
			if (res.code != 0) {
				p.state = 'failed';
				p.error = res.output;
				ui.addNotification(null, E('p', {}, [ _('The message was not sent: %s').format(res.output || res.code) ]), 'error');
				this.text.value = text;
				this.draw();
				return;
			}

			this.pending = this.pending.filter(x => x != p);

			return this.reload();
		});
	},

	remove(msgs, all) {
		const ids = msgs.flatMap(m => m.ids || []);

		ui.showModal(all ? _('Delete conversation') : _('Delete message'), [
			E('p', {}, [ all ? _('Delete all %d messages of this conversation, from the modem and from this list?').format(msgs.length)
				: _('Delete this message?') ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]), ' ',
				E('button', { 'class': 'btn cbi-button-negative', 'click': () => {
					ui.hideModal();

					return modem.smsDelete(ids).then(res => {
						if (res.code != 0)
							ui.addNotification(null, E('p', {}, [ _('Not everything was deleted: %s').format(res.output) ]), 'warning');

						if (all)
							this.current = null;

						return this.reload(true);
					});
				} }, [ _('Delete') ])
			])
		]);
	},

	render(data) {
		this.pending = [];
		this.current = null;
		this.apply(data);

		this.search = E('input', { 'type': 'search', 'class': 'cbi-input-text', 'placeholder': _('Search'), 'aria-label': _('Search'),
			'input': () => this.listBox.replaceChildren(...this.renderList()) });
		this.listBox = E('div', { 'class': 'aw-convs' });
		this.footText = E('div');
		this.where = E('select', { 'class': 'cbi-input-select', 'aria-label': _('Store new messages in'), 'change': ev => {
			const want = ev.target.value;

			ev.target.disabled = true;
			modem.smsStorage(want).then(res => {
				ev.target.disabled = false;

				if (res.code != 0) {
					ev.target.value = this.incoming || '';
					ui.addNotification(null, E('p', {}, [ _('The modem did not take it: %s').format(res.output) ]), 'error');
				}
				else {
					this.incoming = want;
				}
			});
		} }, [
			E('option', { 'value': 'ME' }, [ _('Modem memory') ]),
			E('option', { 'value': 'SM' }, [ _('SIM card') ])
		]);
		this.foot = E('div', { 'class': 'aw-side-foot' }, [
			this.footText,
			E('label', { 'class': 'aw-row', 'style': 'margin-top:.35em' }, [ _('New messages to'), this.where ])
		]);
		this.headBox = E('div', { 'class': 'aw-thread-head' });
		this.msgsBox = E('div', { 'class': 'aw-msgs' });
		this.to = E('input', { 'type': 'tel', 'class': 'cbi-input-text', 'placeholder': _('Phone number'), 'aria-label': _('To'),
			'input': () => this.updateCount() });
		this.text = E('textarea', { 'rows': 1, 'aria-label': _('Message'),
			'input': () => this.updateCount(),
			'keydown': ev => {
				if (ev.key == 'Enter' && !ev.shiftKey && !ev.isComposing) {
					ev.preventDefault();
					this.send();
				}
			} });
		this.sendBtn = E('button', { 'class': 'aw-send', 'title': _('Send'), 'click': () => this.send() }, [ rf.icon('send') ]);
		this.count = E('div', { 'class': 'aw-count' });
		this.composer = E('div', {}, [ E('div', { 'class': 'aw-composer' }, [ this.text, this.sendBtn ]), this.count ]);

		this.root = E('div', { 'class': 'aw-sms' }, [
			E('div', { 'class': 'aw-side' }, [
				E('div', { 'class': 'aw-side-head' }, [
					E('h3', {}, [ _('SMS Messages') ]),
					E('button', { 'class': 'aw-iconbtn', 'title': _('Refresh'), 'click': () => this.reload(true) }, [ rf.icon('refresh') ]),
					E('button', { 'class': 'aw-iconbtn', 'title': _('New message'), 'click': () => this.open('new') }, [ rf.icon('plus') ])
				]),
				E('div', { 'class': 'aw-search' }, [ this.search ]),
				this.listBox,
				this.foot
			]),
			E('div', { 'class': 'aw-thread' }, [ this.headBox, this.msgsBox, this.composer ])
		]);

		this.draw();

		// New messages show up on their own; each look is a read of the modem.
		poll.add(() => (document.visibilityState == 'visible') ? this.reload(true) : Promise.resolve(), 30);

		return E('div', { 'class': 'aw' }, [
			modem.css(),
			this.root
		]);
	}
});
