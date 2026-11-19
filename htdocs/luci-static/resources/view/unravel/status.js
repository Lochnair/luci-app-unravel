'use strict';
'require dom';
'require poll';
'require rpc';
'require ui';
'require uci';
'require view';
'require unravel.common as common';

const POLL_INTERVAL = 2;
// Samples kept per instance in the browser, for the charts: 5 minutes.
const HISTORY = 150;

const COLORS = { download: '#2e7bcf', upload: '#d9822b' };
const DIRECTIONS = [
	{ dir: 'download', title: _('Download') },
	{ dir: 'upload', title: _('Upload') }
];

const callInitAction = rpc.declare({
	object: 'luci',
	method: 'setInitAction',
	params: [ 'name', 'action' ],
	expect: { result: false }
});

const callInitList = rpc.declare({
	object: 'luci',
	method: 'getInitList',
	params: [ 'name' ],
	expect: { '': {} }
});

// Each running instance publishes `unravel` (unnamed) or `unravel.<name>`
// on ubus. A stopped one has no object, so the call fails.
const statusCalls = {};
function callInstanceStatus(name) {
	const object = (name === 'default') ? 'unravel' : 'unravel.' + name;
	statusCalls[object] = statusCalls[object] ?? rpc.declare({
		object,
		method: 'status',
		expect: { '': {} }
	});
	return L.resolveDefault(statusCalls[object](), null);
}

function svg(tag, attrs, children) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const k in attrs)
		el.setAttribute(k, attrs[k]);
	for (const c of L.toArray(children))
		el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	return el;
}

// Rate (solid) and traffic (faint) of both directions over the samples kept
// since the page was opened. Each direction is scaled to its own base rate
// so a slow upload is not flattened by a fast download.
function chart(samples) {
	const W = 640, H = 120, PAD = 4;
	const root = svg('svg', {
		viewBox: '0 0 %d %d'.format(W, H),
		width: '100%',
		preserveAspectRatio: 'none',
		style: 'display:block;height:7em;margin:.4em 0 .2em'
	});

	root.appendChild(svg('line', { x1: 0, x2: W, y1: H - PAD, y2: H - PAD, stroke: 'currentColor', 'stroke-opacity': 0.3 }));

	if (samples.length < 2)
		return root;

	const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
	const x = (t) => (t1 > t0 ? (t - t0) / (t1 - t0) : 0) * W;

	for (const { dir } of DIRECTIONS) {
		const scale = Math.max(...samples.map((s) => s[dir]?.base_kbps ?? 0)) * 1.5;
		if (!(scale > 0))
			continue;

		const y = (v) => H - PAD - Math.min(v, scale) / scale * (H - 2 * PAD);
		const path = (key) => {
			let d = '', pen = false;
			for (const s of samples) {
				const v = s[dir]?.[key];
				if (v == null) {
					pen = false;
					continue;
				}
				d += '%s%.1f,%.1f'.format(pen ? 'L' : 'M', x(s.t), y(v));
				pen = true;
			}
			return d;
		};

		const traffic = path('traffic_kbps');
		if (traffic)
			root.appendChild(svg('path', { d: traffic, fill: 'none', stroke: COLORS[dir], 'stroke-opacity': 0.35, 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }));
		const rate = path('rate_kbps');
		if (rate)
			root.appendChild(svg('path', { d: rate, fill: 'none', stroke: COLORS[dir], 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
	}

	return root;
}

function rateRow(dir, title, d) {
	if (!d)
		return E('div', { style: 'margin:.5em 0' }, [ E('strong', {}, title), ' ', E('em', {}, _('not controlled')) ]);

	const scale = (d.base_kbps || d.rate_kbps || 1) * 1.5;
	const pct = (v) => Math.max(0, Math.min(100, v / scale * 100));
	const marker = (v, label, opacity) => E('div', {
		title: label,
		style: 'position:absolute;top:-.25em;bottom:-.25em;width:2px;left:%.1f%%;background:currentColor;opacity:%s'.format(pct(v), opacity)
	});

	return E('div', { style: 'margin:.6em 0' }, [
		E('div', { style: 'display:flex;justify-content:space-between;gap:1em;flex-wrap:wrap' }, [
			E('span', {}, [ E('strong', {}, title), ' ', E('small', { style: 'opacity:.7' }, d.interface) ]),
			E('span', {}, [
				E('strong', {}, d.rate_kbps != null ? common.formatKbits(d.rate_kbps) : _('no rate set yet')),
				' ',
				E('small', { style: 'opacity:.7' }, d.traffic_kbps != null
					? _('%s in use').format(common.formatKbits(d.traffic_kbps)) : '')
			])
		]),
		E('div', { style: 'position:relative;height:.6em;border-radius:.3em;background:rgba(128,128,128,.2);margin-top:.3em' }, [
			E('div', { style: 'position:absolute;left:0;top:0;bottom:0;border-radius:.3em;opacity:.35;width:%.1f%%;background:%s'.format(d.traffic_kbps != null ? pct(d.traffic_kbps) : 0, COLORS[dir]) }),
			E('div', { style: 'position:absolute;left:0;top:.15em;bottom:.15em;border-radius:.3em;width:%.1f%%;background:%s'.format(d.rate_kbps != null ? pct(d.rate_kbps) : 0, COLORS[dir]) }),
			marker(d.min_kbps, _('minimum %s').format(common.formatKbits(d.min_kbps)), 0.4),
			marker(d.base_kbps, _('base %s').format(common.formatKbits(d.base_kbps)), 0.7)
		]),
		E('div', { style: 'display:flex;justify-content:space-between;font-size:85%;opacity:.7;margin-top:.15em' }, [
			E('span', {}, _('min %s').format(common.formatKbits(d.min_kbps))),
			E('span', {}, _('base %s').format(common.formatKbits(d.base_kbps)))
		])
	]);
}

function badge(enabled, st) {
	let text, cls;
	if (st)
		[ text, cls ] = st.dry_run ? [ _('Dry run'), 'warning' ] : [ _('Running'), 'success' ];
	else if (!enabled)
		[ text, cls ] = [ _('Disabled'), 'notice' ];
	else
		[ text, cls ] = [ _('Not running'), 'danger' ];
	return E('span', { 'class': 'label ' + cls, style: 'margin-left:.6em' }, text);
}

return view.extend({
	history: {},

	load() {
		return Promise.all([
			uci.load('unravel'),
			L.resolveDefault(callInitList('unravel'), {})
		]);
	},

	// The configured instances, in config order, by the name unravel uses.
	instances() {
		return uci.sections('unravel', 'network').map((s) => ({
			name: common.instanceName(s['.name']),
			enabled: !/^(0|false|no|n|off|disabled)$/i.test(s.enabled ?? '1')
		}));
	},

	handleAction(action) {
		return callInitAction('unravel', action).then((ok) => {
			if (!ok)
				ui.addTimeLimitedNotification(null, E('p', _('Could not %s unRAVEL').format(action)), 5000, 'danger');
			return L.resolveDefault(callInitList('unravel'), {});
		}).then((init) => {
			dom.content(this.controlsEl, this.renderControls(init));
			return this.refresh();
		});
	},

	renderControls(init) {
		const enabled = init?.unravel?.enabled;
		const btn = (action, label, cls) => E('button', {
			'class': 'cbi-button ' + (cls ?? ''),
			'click': ui.createHandlerFn(this, 'handleAction', action)
		}, label);

		return E('div', { style: 'display:flex;gap:.5em;flex-wrap:wrap;align-items:center' }, [
			btn('restart', _('Restart'), 'cbi-button-apply'),
			btn('start', _('Start')),
			btn('stop', _('Stop'), 'cbi-button-reset'),
			enabled
				? btn('disable', _('Disable at boot'))
				: btn('enable', _('Enable at boot'), 'cbi-button-positive'),
			E('span', { style: 'opacity:.7' }, enabled ? _('Starts at boot') : _('Does not start at boot'))
		]);
	},

	renderInstance(inst, st) {
		const head = E('div', { style: 'display:flex;align-items:center;flex-wrap:wrap;gap:.2em' }, [
			E('strong', { style: 'font-size:110%' }, inst.name === 'default' ? _('Unnamed instance') : inst.name),
			badge(inst.enabled, st),
			st ? E('span', { style: 'margin-left:auto;opacity:.75' }, [
				common.LAWS[st.law]?.title ?? st.law,
				' · ', _('%d reflectors').format(st.reflectors),
				' · ', _('up %s').format('%t'.format(st.uptime)),
				' · ', 'v' + st.version
			]) : ''
		]);

		if (!st)
			return E('div', { 'class': 'cbi-section-node', style: 'padding:.8em 1em;margin-bottom:.8em' }, [
				head,
				E('p', { style: 'margin:.5em 0 0;opacity:.8' }, inst.enabled
					? _('No status on ubus. The instance is stopped, failed to start, or runs a build without ubus support. Check the system log.')
					: _('Not started: disabled on the Instances page.'))
			]);

		return E('div', { 'class': 'cbi-section-node', style: 'padding:.8em 1em;margin-bottom:.8em' }, [
			head,
			rateRow('download', _('Download'), st.download),
			rateRow('upload', _('Upload'), st.upload),
			chart(this.history[inst.name] ?? []),
			E('div', { style: 'font-size:85%;opacity:.7' },
				_('Last %s: solid lines are the shaper rate, faint lines the traffic, each relative to its base rate.')
					.format('%t'.format(Math.round(HISTORY * POLL_INTERVAL))))
		]);
	},

	refresh() {
		const list = this.instances();

		return Promise.all(list.map((i) => callInstanceStatus(i.name))).then((statuses) => {
			const now = Date.now() / 1000;

			list.forEach((inst, n) => {
				const st = statuses[n];
				const h = this.history[inst.name] = this.history[inst.name] ?? [];
				if (st)
					h.push({ t: now, download: st.download, upload: st.upload });
				else
					h.length = 0;
				if (h.length > HISTORY)
					h.splice(0, h.length - HISTORY);
			});

			dom.content(this.instancesEl, list.length
				? list.map((inst, n) => this.renderInstance(inst, statuses[n]))
				: E('em', {}, _('No instances are configured. Add one on the Instances page.')));
		});
	},

	render([ , init ]) {
		this.controlsEl = E('div', { 'class': 'cbi-section' }, this.renderControls(init));
		this.instancesEl = E('div', { 'class': 'cbi-section' }, E('em', {}, _('Loading…')));

		poll.add(() => this.refresh(), POLL_INTERVAL);
		this.refresh();

		return E([], [
			E('h2', {}, _('unRAVEL status')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Rates and traffic as reported by each running instance.')),
			this.controlsEl,
			this.instancesEl
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
