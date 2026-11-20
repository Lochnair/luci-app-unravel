'use strict';
'require dom';
'require poll';
'require rpc';
'require ui';
'require uci';
'require view';
'require unravel.common as common';

const POLL_INTERVAL = 2;

const DIRECTIONS = [
	{ dir: 'download', title: _('Download') },
	{ dir: 'upload', title: _('Upload') }
];

function formatDelay(us) {
	if (us == null || isNaN(us))
		return '-';
	const ms = us / 1000;
	return '%s ms'.format(ms.toFixed(Math.abs(ms) < 10 ? 2 : 1));
}

function formatPercent(pct) {
	return (pct == null || isNaN(pct)) ? '-' : '%d %%'.format(Math.round(pct));
}

// The plots of one direction, top to bottom, on one time axis. `series`
// is the history key, `current` the status key; `refs` are dashed lines
// the scale always reaches.
const PLOTS = [
	{ series: 'rate_kbps', current: 'rate_kbps', title: _('Shaper rate'), color: 'blue', height: 150,
	  format: common.formatKbits, floor: 1000,
	  refs: (d) => [ [ d.base_kbps, _('base') ], [ d.min_kbps, _('min') ] ] },
	{ series: 'traffic_kbps', current: 'traffic_kbps', title: _('Traffic'), color: 'green', height: 110,
	  format: common.formatKbits, floor: 100,
	  refs: () => [] },
	{ series: 'delay_us', current: 'delay_us', title: _('Delay above baseline'), label: _('Delay'), color: '#c60', height: 110,
	  format: formatDelay, floor: 1000, optional: true,
	  refs: (d) => d.delay_threshold_us != null ? [ [ d.delay_threshold_us, _('threshold') ] ] : [] }
];

const PROTOCOLS = {
	'icmp-echo': _('ICMP echo'),
	'icmp-timestamps': _('ICMP timestamps'),
	'irtt': 'IRTT'
};

const ONE_WAY = {
	usable: _('usable'),
	reference_changed: _('reference changed'),
	invalid_rtt: _('invalid RTT'),
	inconsistent_timestamps: _('inconsistent timestamps'),
	directional_discontinuity: _('discontinuity'),
	local_clock_step: _('local clock step'),
	out_of_order: _('out of order')
};

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
// on ubus, with `status`, `history` and `reflectors`. A stopped one has no
// object, so the call fails and resolves to null.
const calls = {};
function callInstance(name, method) {
	const object = (name === 'default') ? 'unravel' : 'unravel.' + name;
	const key = object + '/' + method;
	calls[key] = calls[key] ?? rpc.declare({ object, method, expect: { '': {} } });
	return L.resolveDefault(calls[key](), null);
}

function svg(tag, attrs, text) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const k in attrs)
		el.setAttribute(k, attrs[k]);
	if (text != null)
		el.appendChild(document.createTextNode(text));
	return el;
}

function formatDuration(secs) {
	const s = Math.max(0, Math.floor(secs));
	const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
	if (d)
		return '%dd %dh'.format(d, h);
	if (h)
		return '%dh %dm'.format(h, m);
	if (m)
		return (s % 60) ? '%dm %ds'.format(m, s % 60) : '%dm'.format(m);
	return '%ds'.format(s);
}

// A 1, 2 or 5 times a power of ten, at least max / ticks.
function niceStep(max, ticks) {
	const raw = max / ticks;
	const mag = Math.pow(10, Math.floor(Math.log10(raw)));
	for (const m of [ 1, 2, 5 ])
		if (raw <= m * mag)
			return m * mag;
	return 10 * mag;
}

function badge(enabled, st) {
	let text, cls;
	if (st)
		[ text, cls ] = st.dry_run ? [ _('Dry run'), 'warning' ] : [ _('Running'), 'success' ];
	else if (!enabled)
		[ text, cls ] = [ _('Disabled'), 'notice' ];
	else
		[ text, cls ] = [ _('Not running'), 'danger' ];
	return E('span', { 'class': 'label ' + cls }, text);
}

function mean(values) {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// The text style of LuCI's realtime graphs (svg/bandwidth.svg).
const TEXT_STYLE = 'fill:#eee;font-size:9pt;font-family:sans-serif;text-shadow:1px 1px 1px #000';
const GRID_STYLE = 'stroke:black;stroke-width:0.1';

// One plot: a box around an SVG, as on Status > Realtime Graphs, so themes
// that restyle those (`#view div[style] > svg`, `line[style]`) restyle
// these too. Everything is drawn in measured pixels.
function createPlot(def) {
	const root = svg('svg', { width: '100%', height: def.height, style: 'display:block;width:100%;height:%dpx'.format(def.height) });
	const area = svg('polyline', { points: '', style: 'fill:%s;fill-opacity:0.2;stroke:%s;stroke-width:1'.format(def.color, def.color) });
	const grid = svg('g'), times = svg('g'), refs = svg('g');
	root.append(area, grid, times, refs);
	return {
		def, root, area, grid, times, refs,
		el: E('div', { style: 'margin-bottom:.4em' }, [
			E('div', { style: 'display:flex;justify-content:space-between;align-items:baseline' }, [
				E('strong', { style: 'border-bottom:2px solid ' + def.color }, def.title),
				E('small', { style: 'opacity:.75' }, '')
			]),
			E('div', { style: 'width:100%;border:1px solid #000;background:#fff;margin-top:.2em' }, root)
		])
	};
}

// `values` are oldest first, `capacity` slots span the full width, and the
// newest value sits on the right edge.
function drawPlot(p, values, capacity, perMinute, last, refs) {
	const rect = p.root.getBoundingClientRect();
	const width = Math.floor(rect.width), height = Math.floor(rect.height);
	if (!width || !height)
		return;	// in a hidden tab; drawn when it is shown

	let peak = 0;
	for (const v of values)
		if (v != null)
			peak = Math.max(peak, v);
	for (const [ v ] of refs)
		peak = Math.max(peak, v ?? 0);
	// Headroom keeps a reference line and its label off the top edge.
	const want = Math.max(peak, p.def.floor) * 1.15;
	const step = niceStep(want, 4);
	const top = Math.ceil(want / step) * step;
	const y = (v) => height - Math.round(Math.min(Math.max(v, 0), top) / top * (height - 1));
	const dx = width / Math.max(capacity - 1, 1);
	const x = (i) => Math.round(width - (values.length - 1 - i) * dx);

	// Leading nulls (before the first value) are left out; a later gap
	// holds the previous value.
	const first = values.findIndex((v) => v != null);
	let pts = '';
	if (first >= 0) {
		let prev = values[first];
		pts = '%d,%d'.format(x(first), height);
		for (let i = first; i < values.length; i++) {
			prev = values[i] ?? prev;
			pts += ' %d,%d'.format(x(i), y(prev));
		}
		pts += ' %d,%d'.format(width, height);
	}
	p.area.setAttribute('points', pts);

	const lines = [];
	for (const frac of [ 0.25, 0.5, 0.75 ]) {
		const gy = y(top * frac);
		lines.push(svg('line', { x1: 0, y1: gy, x2: width, y2: gy, style: GRID_STYLE }),
			svg('text', { x: 8, y: gy - 3, style: TEXT_STYLE }, p.def.format(top * frac)));
	}
	p.grid.replaceChildren(...lines);

	const marks = [];
	for (let m = 1; m * perMinute <= capacity; m++) {
		const mx = Math.round(width - m * perMinute * dx);
		marks.push(svg('line', { x1: mx, y1: 0, x2: mx, y2: height, style: GRID_STYLE }));
		if (last)
			marks.push(svg('text', { x: mx + 4, y: height - 4, style: TEXT_STYLE }, '%dm'.format(m)));
	}
	p.times.replaceChildren(...marks);

	const dashed = [];
	for (const [ v, label ] of refs) {
		if (v == null)
			continue;
		const ry = y(v);
		dashed.push(svg('line', { x1: 0, y1: ry, x2: width, y2: ry, style: 'stroke:black;stroke-width:1;stroke-dasharray:6 4' }),
			svg('text', { x: width - 8, y: ry - 4, 'text-anchor': 'end', style: TEXT_STYLE }, '%s %s'.format(label, p.def.format(v))));
	}
	p.refs.replaceChildren(...dashed);
}

function cell(title, content, cls) {
	return E('td', { 'class': 'td' + (cls ? ' ' + cls : ''), 'data-title': title }, content);
}

return view.extend({
	statuses: [],
	busy: false,

	load() {
		return Promise.all([
			uci.load('unravel'),
			L.resolveDefault(callInitList('unravel'), {})
		]);
	},

	// Refreshes until `done(statuses)` holds, for up to `tries` seconds.
	// The init script returns once procd has signalled the instances, and
	// an instance keeps answering on ubus while it shuts down.
	waitFor(done, tries) {
		return this.refresh().then((sts) => {
			if (done(sts) || tries <= 0)
				return done(sts);
			return new Promise((r) => setTimeout(r, 1000)).then(() => this.waitFor(done, tries - 1));
		});
	},

	handleAction(action) {
		const startedAt = Date.now() / 1000;
		const expect = {
			stop: [ (sts) => sts.every((s) => !s), _('unRAVEL is still running. Check the system log.') ],
			start: [ (sts) => sts.some(Boolean), _('No instance started. Check the system log.') ],
			restart: [ (sts) => sts.some((s) => s && s.uptime <= Date.now() / 1000 - startedAt + 2),
				_('No instance restarted. Check the system log.') ]
		}[action];

		this.busy = true;
		return callInitAction('unravel', action).then((ok) => {
			if (!ok)
				throw new Error(_('The init script failed to %s unRAVEL.').format(action));
			if (expect)
				return this.waitFor(expect[0], 10).then((reached) => {
					if (!reached)
						throw new Error(expect[1]);
				});
		}).catch((e) => {
			ui.addTimeLimitedNotification(null, E('p', e.message), 8000, 'danger');
		}).then(() => L.resolveDefault(callInitList('unravel'), {})).then((init) => {
			this.init = init;
			this.busy = false;
			this.renderControls();
		});
	},

	renderControls() {
		if (this.busy)
			return;

		const boot = this.init?.unravel?.enabled;
		const total = this.panes.length;
		const running = this.statuses.filter(Boolean).length;
		const btn = (action, label, cls) => E('button', {
			'class': 'cbi-button ' + (cls ?? ''),
			'click': ui.createHandlerFn(this, 'handleAction', action)
		}, label);

		// Rebuilding the buttons on every poll would swallow clicks.
		const key = [ boot, running, total ].join();
		if (key === this.controlsKey)
			return;
		this.controlsKey = key;

		let state;
		if (!total)
			state = _('No instances configured');
		else if (!running)
			state = _('Stopped');
		else if (running < total)
			state = _('%d of %d instances running').format(running, total);
		else
			state = _('Running');

		dom.content(this.controlsEl, E('div', { style: 'display:flex;gap:.5em;flex-wrap:wrap;align-items:center' }, [
			E('span', { style: 'margin-right:auto' }, [
				E('strong', {}, state), ' · ',
				E('span', { style: 'opacity:.75' }, boot ? _('starts at boot') : _('does not start at boot'))
			]),
			running ? btn('restart', _('Restart'), 'cbi-button-apply') : '',
			running ? btn('stop', _('Stop'), 'cbi-button-reset') : btn('start', _('Start'), 'cbi-button-apply'),
			boot ? btn('disable', _('Disable at boot')) : btn('enable', _('Enable at boot'))
		]));
	},

	// A tab per configured instance, built once and updated in place.
	createPane(s) {
		const name = common.instanceName(s['.name']);
		const pane = {
			name,
			enabled: !/^(0|false|no|n|off|disabled)$/i.test(s.enabled ?? '1'),
			info: E('div', { style: 'display:flex;align-items:center;flex-wrap:wrap;gap:.3em .6em;margin-bottom:1em' }),
			message: E('p', { style: 'display:none' }),
			noHistory: E('p', { style: 'display:none' },
				_('This unRAVEL version has no history on ubus, so there are no graphs. Update unRAVEL to get them.')),
			directions: {},
			reflectors: E('div')
		};

		const body = DIRECTIONS.map(({ dir }) => {
			const d = pane.directions[dir] = {
				title: E('h3', {}, ''),
				plots: PLOTS.map(createPlot),
				window: E('div', { 'class': 'right' }, E('small', {}, '')),
				rows: PLOTS.concat([ { title: _('Utilisation'), color: 'transparent' } ]).map((def) => ({
					def,
					cells: [ 0, 1, 2 ].map(() => E('td', { 'class': 'td' }, '-'))
				}))
			};
			d.rows.splice(2, 0, d.rows.pop());	// utilisation after traffic
			d.graphs = E('div', {}, [ ...d.plots.map((p) => p.el), d.window ]);
			d.table = E('table', { 'class': 'table', style: 'width:100%;table-layout:fixed;margin-top:.5em' }, d.rows.map((r) => {
				r.el = E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td right top' }, E('strong', {}, (r.def.label ?? r.def.title) + ':')),
					r.cells[0],
					E('td', { 'class': 'td right top' }, E('strong', {}, _('Average:'))),
					r.cells[1],
					E('td', { 'class': 'td right top' }, E('strong', {}, _('Peak:'))),
					r.cells[2]
				]);
				return r.el;
			}));
			d.missing = E('p', { style: 'display:none' }, _('Not shaped by this instance.'));
			d.content = E('div', {}, [ d.graphs, d.table ]);
			d.el = E('div', { style: 'margin-bottom:2em' }, [ d.title, d.missing, d.content ]);
			return d.el;
		});

		pane.body = E('div', {}, [
			pane.noHistory,
			...body,
			E('h3', {}, _('Reflectors')),
			pane.reflectors
		]);

		pane.el = E('div', { 'class': 'cbi-section', 'data-tab': name, 'data-tab-title': name }, [
			pane.info, pane.message, pane.body
		]);
		// Only the shown tab fetches its history and reflectors.
		pane.el.addEventListener('cbi-tab-active', () => this.refreshDetails(pane));
		return pane;
	},

	visible(pane) {
		return this.panes.length === 1 || pane.el.getAttribute('data-tab-active') === 'true';
	},

	draw(pane) {
		const st = pane.status, hist = pane.history;
		if (!st)
			return;
		pane.noHistory.style.display = hist ? 'none' : '';

		const interval = hist?.interval || POLL_INTERVAL;
		const capacity = Math.max(2, Math.round((hist?.window || 600) / interval));
		const perMinute = 60 / interval;

		for (const { dir, title } of DIRECTIONS) {
			const d = pane.directions[dir], cur = st[dir], h = hist?.[dir];
			d.missing.style.display = cur ? 'none' : '';
			d.content.style.display = cur ? '' : 'none';
			d.title.textContent = cur ? '%s (%s)'.format(title, cur.interface) : title;
			if (!cur)
				continue;

			d.graphs.style.display = h ? '' : 'none';
			const shown = PLOTS.map((def) => !def.optional || h?.[def.series] != null || cur[def.current] != null);
			d.plots.forEach((p, i) => {
				p.el.style.display = shown[i] ? '' : 'none';
				const lastShown = shown.lastIndexOf(true) === i;
				if (h && shown[i])
					drawPlot(p, h[p.def.series] ?? [], capacity, perMinute, lastShown, p.def.refs(cur));
				p.el.firstChild.lastChild.textContent = p.def.format(cur[p.def.current]);
			});
			d.window.firstChild.textContent = _('%d minute window, %d second interval').format(
				Math.round(capacity * interval / 60), interval);

			// Utilisation per slot, where both the rate and traffic are known.
			const util = (h?.rate_kbps ?? []).map((r, i) => {
				const t = h.traffic_kbps?.[i];
				return (r > 0 && t != null) ? t / r * 100 : null;
			});
			for (const r of d.rows) {
				const isUtil = !r.def.series;
				const values = (isUtil ? util : (h?.[r.def.series] ?? [])).filter((v) => v != null);
				const format = isUtil ? formatPercent : r.def.format;
				const now = isUtil
					? (cur.rate_kbps > 0 && cur.traffic_kbps != null ? cur.traffic_kbps / cur.rate_kbps * 100 : null)
					: cur[r.def.current];
				r.el.style.display = (!r.def.optional || shown[PLOTS.indexOf(r.def)]) ? '' : 'none';
				r.cells[0].textContent = format(now);
				r.cells[1].textContent = values.length ? format(mean(values)) : '-';
				r.cells[2].textContent = values.length ? format(Math.max(...values)) : '-';
			}
		}

		this.drawReflectors(pane);
	},

	drawReflectors(pane) {
		const list = pane.reflectorList;
		if (list == null) {
			dom.content(pane.reflectors, E('em', {}, pane.history === null
				? _('This unRAVEL version does not list its reflectors on ubus.') : _('Loading…')));
			return;
		}
		if (!list.length) {
			dom.content(pane.reflectors, E('em', {}, _('No reflectors are being probed yet.')));
			return;
		}

		const heads = [ _('Reflector'), _('Protocol'), _('Role'), _('Loss'), _('RTT'),
			_('Average RTT'), _('Minimum RTT'), _('Jitter'), _('Last reply'), _('One-way') ];
		const ago = (ms) => ms == null ? '-' : (ms < 1000 ? _('%d ms ago').format(ms) : _('%s ago').format(formatDuration(ms / 1000)));
		// Ten columns don't fit a phone; the table scrolls on its own.
		dom.content(pane.reflectors, E('div', { style: 'overflow-x:auto' }, E('table', { 'class': 'table cbi-section-table' }, [
			E('tr', { 'class': 'tr table-titles' }, heads.map((h) => E('th', { 'class': 'th' }, h))),
			...list.map((r, i) => {
				const role = r.role === 'active' ? _('Active') : _('Candidate');
				return E('tr', { 'class': 'tr cbi-rowstyle-%d'.format(i % 2 + 1), style: r.ready ? '' : 'opacity:.6' }, [
					cell(heads[0], E('code', {}, r.reflector)),
					cell(heads[1], PROTOCOLS[r.protocol] ?? r.protocol),
					cell(heads[2], r.ready ? E('strong', {}, role) : _('%s (starting)').format(role)),
					cell(heads[3], r.probes ? '%s (%d)'.format(formatPercent(r.loss_pct), r.probes) : '-'),
					cell(heads[4], formatDelay(r.rtt_us)),
					cell(heads[5], formatDelay(r.rtt_avg_us)),
					cell(heads[6], formatDelay(r.rtt_min_us)),
					cell(heads[7], formatDelay(r.jitter_us)),
					cell(heads[8], ago(r.last_reply_ms)),
					cell(heads[9], r.one_way ? (ONE_WAY[r.one_way] ?? r.one_way) : '-')
				]);
			})
		])));
	},

	updatePane(pane, st) {
		pane.status = st;

		dom.content(pane.info, [
			badge(pane.enabled, st),
			st ? E('span', { style: 'opacity:.75' }, [
				_('%s law').format(common.LAWS[st.law]?.title ?? st.law),
				' · ', _('%d reflectors').format(st.reflectors),
				' · ', _('up %s').format(formatDuration(st.uptime)),
				' · ', 'v' + st.version
			]) : ''
		]);

		if (!st) {
			pane.history = pane.reflectorList = undefined;
			pane.body.style.display = 'none';
			pane.message.style.display = '';
			pane.message.textContent = pane.enabled
				? _('No status on ubus. The instance is stopped, failed to start, or runs a build without ubus support. Check the system log.')
				: _('Disabled on the Instances page.');
			return;
		}
		pane.body.style.display = '';
		pane.message.style.display = 'none';
	},

	// The history and reflectors of one running instance.
	refreshDetails(pane) {
		if (!pane.status)
			return Promise.resolve();
		return Promise.all([
			callInstance(pane.name, 'history'),
			callInstance(pane.name, 'reflectors')
		]).then(([ hist, refl ]) => {
			pane.history = hist;
			pane.reflectorList = refl ? (refl.reflectors ?? []) : (hist === null ? null : undefined);
			this.draw(pane);
		});
	},

	refresh() {
		return Promise.all(this.panes.map((p) => callInstance(p.name, 'status'))).then((statuses) => {
			this.panes.forEach((p, n) => this.updatePane(p, statuses[n]));
			this.statuses = statuses;
			this.renderControls();
			return Promise.all(this.panes.filter((p) => this.visible(p)).map((p) => this.refreshDetails(p)))
				.then(() => statuses);
		});
	},

	render([ , init ]) {
		this.init = init;
		this.controlsEl = E('div', { 'class': 'cbi-section' });
		this.panes = uci.sections('unravel', 'network').map((s) => this.createPane(s));

		const map = E('div', { 'class': 'cbi-map' }, E('div', {}, this.panes.map((p) => p.el)));
		if (this.panes.length)
			ui.tabs.initTabGroup(map.firstElementChild.childNodes);
		else
			map.firstElementChild.appendChild(E('div', { 'class': 'cbi-section' },
				E('em', {}, _('No instances are configured. Add one on the Instances page.'))));

		poll.add(() => this.refresh(), POLL_INTERVAL);
		this.refresh();

		return E([], [
			E('h2', {}, _('unRAVEL')),
			this.controlsEl,
			map
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
