'use strict';
'require baseclass';
'require rpc';

// The modem pages' side of the luci.aw1000-modem backend, and the pages'
// stylesheet.

const callAt = rpc.declare({ object: 'luci.aw1000-modem', method: 'at', params: [ 'command', 'timeout' ] });
const callJobStart = rpc.declare({ object: 'luci.aw1000-modem', method: 'job_start', params: [ 'command', 'timeout' ] });
const callJobStatus = rpc.declare({ object: 'luci.aw1000-modem', method: 'job_status' });
const callSmsList = rpc.declare({ object: 'luci.aw1000-modem', method: 'sms_list' });
const callSmsSend = rpc.declare({ object: 'luci.aw1000-modem', method: 'sms_send', params: [ 'number', 'text' ] });
const callSmsDelete = rpc.declare({ object: 'luci.aw1000-modem', method: 'sms_delete', params: [ 'ids' ] });
const callSmsStorage = rpc.declare({ object: 'luci.aw1000-modem', method: 'sms_storage', params: [ 'storage' ] });
const callLock = rpc.declare({ object: 'luci.aw1000-modem', method: 'lock', params: [ 'lte', 'nr5g_sa' ] });

// What the backend answers when it cannot run a command at all.
const failed = err => ({ code: 3, output: String(err && err.message || err) });

return baseclass.extend({
	// { code, output }: code 0 OK, 1 an error result, 2 timeout, 3 not run.
	// Commands answered within 15 s; longer ones go through job().
	at(command, timeout) {
		return callAt(command, timeout || 10).catch(failed);
	},

	// A slow command (a cell scan takes about 100 s) run in the background on
	// the router, so the request does not time out: resolves like at().
	// progress(elapsed, timeout) is called every poll. If the same command is
	// still running from earlier (a reloaded page), waits for that one.
	job(command, timeout, progress) {
		const poll = () => new Promise(resolve => window.setTimeout(resolve, 2000))
			.then(() => callJobStatus())
			.then(st => {
				if (st.running) {
					if (progress)
						progress(st.now - st.started, st.timeout);

					return poll();
				}

				return { code: st.code != null ? st.code : 3, output: st.output || '' };
			});

		return callJobStatus().then(st => {
			if (st.running && st.command == command)
				return poll();

			return callJobStart(command, timeout).then(res => (res.code == 0) ? poll() : res);
		}).catch(failed);
	},

	// The last job on the router, running or done: { running, command,
	// started, now, timeout, code, output }, or {} before the first one.
	jobStatus() {
		return callJobStatus().catch(() => ({}));
	},

	smsList() {
		return callSmsList();
	},

	smsSend(number, text) {
		return callSmsSend(number, text).catch(failed);
	},

	smsDelete(ids) {
		return callSmsDelete(ids).catch(failed);
	},

	// Where new messages go: "ME" (modem) or "SM" (SIM).
	smsStorage(storage) {
		return callSmsStorage(storage).catch(failed);
	},

	// Sets and saves a cell lock: lte [ "<earfcn>,<pci>", ... ] and/or
	// nr5g_sa "<pci>,<arfcn>,<scs>,<band>"; empty unlocks, null leaves
	// that one alone.
	lock(lte, nr5g_sa) {
		return callLock(lte, nr5g_sa).catch(failed);
	},

	// The pages' stylesheet, as an element of the page itself: Footstrap's
	// router turns off a <head> stylesheet on every page but the one that
	// added it, so one added there by an earlier modem page would be off.
	css() {
		return E('link', { 'rel': 'stylesheet', 'href': L.resource('aw1000/modem.css') + '?v=' + (L.env.resource_version || '') });
	},

	// The lines of a reply without the final OK.
	lines(output) {
		return (output || '').split('\n').filter(l => l.trim() && l.trim() != 'OK');
	}
});
