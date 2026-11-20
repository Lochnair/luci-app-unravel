'use strict';
'require dom';
'require request';
'require poll';
'require rpc';
'require ui';
'require uci';
'require view';
'require unravel.common as common';

const POLL_INTERVAL = 2;

// The graphs follow Status > Realtime Graphs: the same box around an SVG
// template (unravel/graph.svg, modelled on svg/bandwidth.svg), so themes
// that restyle those restyle these too.
const GRAPH_HEIGHT = 300;
const STEP = 5;			// pixels per sample
const MAX_SAMPLES = 1000;
const SERIES = [
	{ key: 'rate_kbps', line: 'rate', title: _('Shaper rate:'), color: 'blue' },
	{ key: 'traffic_kbps', line: 'traffic', title: _('Traffic:'), color: 'green' }
];
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

// One direction's graph, cloned from the template, and its
// current/average/peak table.
function createGraph(template, title) {
	const root = template.cloneNode(true);
	const byId = (id) => root.getElementById(id);
	const g = {
		root,
		title: E('h3', {}, title),
		box: E('div', { style: 'width:100%;height:%dpx;border:1px solid #000;background:#fff'.format(GRAPH_HEIGHT) }, root),
		scale: E('small', {}, '-'),
		series: SERIES.map((s) => byId(s.line)),
		labels: [ 25, 50, 75 ].map((pct) => [ pct, byId('label_' + pct) ]),
		times: byId('times'),
		base: byId('base'),
		baseLabel: byId('base_label'),
		textStyle: byId('label_25').getAttribute('style'),
		cells: SERIES.map(() => [ E('td', { 'class': 'td' }, '-'), E('td', { 'class': 'td' }, '-'), E('td', { 'class': 'td' }, '-') ]),
		width: 0
	};
	g.baseLabel.textContent = _('base');

	g.el = E('div', { style: 'margin-bottom:1.5em' }, [
		g.title,
		g.box,
		E('div', { 'class': 'right' }, g.scale),
		E('br'),
		E('table', { 'class': 'table', style: 'width:100%;table-layout:fixed' }, SERIES.map((s, i) => E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td right top' }, E('strong', { style: 'border-bottom:2px solid ' + s.color }, s.title)),
			g.cells[i][0],
			E('td', { 'class': 'td right top' }, E('strong', {}, _('Average:'))),
			g.cells[i][1],
			E('td', { 'class': 'td right top' }, E('strong', {}, _('Peak:'))),
			g.cells[i][2]
		])))
	]);

	return g;
}

// Draws the newest samples that fit, right-aligned, one every STEP pixels.
function drawGraph(g, samples) {
	const width = g.box.clientWidth;
	if (!width || !samples.length)
		return;	// in a hidden tab; drawn when it is shown
	const height = GRAPH_HEIGHT - 2;
	const shown = samples.slice(-Math.floor(width / STEP));
	const last = shown[shown.length - 1];

	// A time marker every minute, as on the realtime graphs.
	if (width !== g.width) {
		g.width = width;
		const perMinute = STEP * 60 / POLL_INTERVAL;
		g.times.replaceChildren();
		for (let x = width % perMinute; x < width; x += perMinute) {
			g.times.appendChild(svg('line', { x1: x, y1: 0, x2: x, y2: '100%', style: 'stroke:black;stroke-width:0.1' }));
			g.times.appendChild(svg('text', { x: x + 5, y: 15, style: g.textStyle }, Math.round((width - x) / perMinute) + 'm'));
		}
	}

	let peak = last.base_kbps || 0;
	for (const s of shown)
		for (const { key } of SERIES)
			peak = Math.max(peak, s[key] ?? 0);
	// Headroom keeps the base line and its label off the top edge.
	const want = (peak || 1000) * 1.1;
	const top = Math.ceil(want / niceStep(want, 4)) * niceStep(want, 4);
	const y = (v) => height - Math.floor(Math.min(v ?? 0, top) / top * height);
	const x0 = width - (shown.length - 1) * STEP;

	SERIES.forEach(({ key }, i) => {
		let pts = '%d,%d'.format(x0, height);
		shown.forEach((s, j) => { pts += ' %d,%d'.format(x0 + j * STEP, y(s[key])); });
		pts += ' %d,%d'.format(width, height);
		g.series[i].setAttribute('points', pts);

		const values = shown.map((s) => s[key]).filter((v) => v != null);
		g.cells[i][0].textContent = common.formatKbits(last[key]);
		g.cells[i][1].textContent = values.length ? common.formatKbits(values.reduce((a, b) => a + b, 0) / values.length) : '-';
		g.cells[i][2].textContent = values.length ? common.formatKbits(Math.max(...values)) : '-';
	});

	for (const [ pct, label ] of g.labels)
		label.firstChild.data = common.formatKbits(top * pct / 100);

	const by = last.base_kbps ? y(last.base_kbps) : -10;
	g.base.setAttribute('y1', by);
	g.base.setAttribute('y2', by);
	g.baseLabel.setAttribute('y', by - 4);

	g.scale.textContent = _('base %s, minimum %s · (%d minute window, %d second interval)').format(
		common.formatKbits(last.base_kbps), common.formatKbits(last.min_kbps),
		Math.floor(width / STEP) * POLL_INTERVAL / 60, POLL_INTERVAL);
}

return view.extend({
	statuses: [],
	busy: false,

	load() {
		return Promise.all([
			uci.load('unravel'),
			L.resolveDefault(callInitList('unravel'), {}),
			request.get(L.resource('unravel/graph.svg')).then((res) => {
				if (!res.ok)
					throw new Error(res.statusText);
				const doc = new DOMParser().parseFromString(res.text(), 'image/svg+xml');
				return document.importNode(doc.documentElement, true);
			})
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
			history: [],
			info: E('div', { style: 'display:flex;align-items:center;flex-wrap:wrap;gap:.3em .6em;margin-bottom:1em' }),
			message: E('p', { style: 'display:none' }),
			graphs: {}
		};

		const body = DIRECTIONS.map(({ dir, title }) => {
			const g = pane.graphs[dir] = createGraph(this.template, title);
			g.missing = E('p', { style: 'display:none' }, _('Not shaped by this instance.'));
			return E('div', {}, [ g.el, g.missing ]);
		});
		pane.body = E('div', {}, body);

		pane.el = E('div', { 'class': 'cbi-section', 'data-tab': name, 'data-tab-title': name }, [
			pane.info, pane.message, pane.body
		]);
		// A graph in a hidden tab has no width; draw it once it is shown.
		pane.el.addEventListener('cbi-tab-active', () => this.draw(pane));
		return pane;
	},

	draw(pane) {
		const st = pane.status;
		if (!st)
			return;
		for (const { dir, title } of DIRECTIONS) {
			const g = pane.graphs[dir], d = st[dir];
			g.el.style.display = d ? '' : 'none';
			g.missing.style.display = d ? 'none' : '';
			if (!d)
				continue;
			g.title.textContent = '%s (%s)'.format(title, d.interface);
			drawGraph(g, pane.history.map((h) => h[dir]).filter(Boolean));
		}
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
			pane.history.length = 0;
			pane.body.style.display = 'none';
			pane.message.style.display = '';
			pane.message.textContent = pane.enabled
				? _('No status on ubus. The instance is stopped, failed to start, or runs a build without ubus support. Check the system log.')
				: _('Disabled on the Instances page.');
			return;
		}

		pane.history.push({ download: st.download, upload: st.upload });
		if (pane.history.length > MAX_SAMPLES)
			pane.history.splice(0, pane.history.length - MAX_SAMPLES);
		pane.body.style.display = '';
		pane.message.style.display = 'none';
		this.draw(pane);
	},

	refresh() {
		return Promise.all(this.panes.map((p) => callInstanceStatus(p.name))).then((statuses) => {
			this.panes.forEach((p, n) => this.updatePane(p, statuses[n]));
			this.statuses = statuses;
			this.renderControls();
			return statuses;
		});
	},

	render([ , init, template ]) {
		this.init = init;
		this.template = template;
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
