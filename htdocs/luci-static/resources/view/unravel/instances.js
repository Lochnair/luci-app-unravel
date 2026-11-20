'use strict';
'require form';
'require rpc';
'require uci';
'require ui';
'require view';
'require unravel.common as common';

// Unfiltered, unlike network.getDevices(), which hides names matching
// ^ifb\d+ and so also SQM's ifb4<wan> devices.
const callNetworkDevices = rpc.declare({
	object: 'luci-rpc',
	method: 'getNetworkDevices',
	expect: { '': {} }
});

const DIRECTIONS = [
	{ dir: 'download', title: _('Download') },
	{ dir: 'upload', title: _('Upload') }
];

function generalFields(s, devices) {
	let o = s.taboption('general', form.Flag, 'enabled', _('Enabled'));
	o.default = '1';

	for (const { dir, title } of DIRECTIONS) {
		o = s.taboption('general', form.Value, dir + '_interface', _('%s interface').format(title),
			dir === 'download'
				? _('Device with the CAKE qdisc shaping downloads, usually the IFB (e.g. <code>ifb4wan</code>). <code>none</code> leaves this direction alone.')
				: _('Device with the CAKE qdisc shaping uploads, usually the WAN device. <code>none</code> leaves this direction alone.'));
		o.value('none', _('none (not controlled)'));
		for (const name of Object.keys(devices).filter((n) => n !== 'lo').sort())
			o.value(name);
		o.rmempty = false;
		if (dir === 'upload') {
			o.validate = function(section_id, value) {
				const other = this.section.formvalue(section_id, 'download_interface');
				if (value === 'none' && other === 'none')
					return _('At least one direction must be controlled');
				return true;
			};
		}

		o = s.taboption('general', form.Value, dir + '_base_kbits', _('%s base rate (kbit/s)').format(title),
			_('The rate you would set in SQM. The shaper can go above it when load and delay allow.'));
		o.datatype = 'ufloat';
		o.validate = function(section_id, value) {
			const iface = this.section.formvalue(section_id, dir + '_interface');
			if (iface !== 'none' && !(+value > 0))
				return _('Required while the direction is controlled');
			return true;
		};

		o = s.taboption('general', form.Value, dir + '_min_percent', _('%s minimum (%% of base)').format(title),
			_('Lowest rate the shaper is set to.'));
		o.datatype = 'range(1,100)';
		o.placeholder = '20';
		o.validate = function(section_id, value) {
			const iface = this.section.formvalue(section_id, dir + '_interface');
			const base = +this.section.formvalue(section_id, dir + '_base_kbits');
			const pct = (value == null || value === '') ? 20 : +value;
			if (iface !== 'none' && base > 0 && Math.floor(base * pct / 100) < 1)
				return _('The minimum rate rounds down to 0 kbit/s');
			return true;
		};

		o = s.taboption('general', form.Value, dir + '_max_percent', _('%s maximum (%% of base)').format(title),
			_('Highest rate any law may set. Empty means no maximum. The cake-autorate script law needs it.'));
		o.datatype = 'and(ufloat,min(100))';
		o.placeholder = _('no maximum');
	}

	// Read by unravel's ICMP and IRTT probes. measurement_fib exists too,
	// but only applies on FreeBSD.
	o = s.taboption('general', form.Value, 'measurement_bind_device', _('Bind probes to device'),
		_('Send this instance\'s probes out of this device only (SO_BINDTODEVICE). Useful with several WANs. Empty uses the routing table.'));
	o.value('', _('Not set'));
	for (const name of Object.keys(devices).filter((n) => n !== 'lo').sort())
		o.value(name);

	o = s.taboption('general', form.Value, 'measurement_mark', _('Probe firewall mark'),
		_('Set this mark (SO_MARK) on the probes, for policy routing such as mwan3 or pbr. Decimal.'));
	o.datatype = 'uinteger';
	o.validate = (section_id, v) =>
		(v == null || v === '' || +v <= 4294967295) ? true : _('Must fit in 32 bits');

	o = s.taboption('general', form.Flag, 'dry_run', _('Dry run'),
		_('Measure and decide without changing the shapers. Still needs the interfaces and CAKE qdiscs to exist.'));
	o.default = '0';
}

// Open the existing instance's detail form on this page. The add dialog
// collects the general settings before the new instance is saved.
const instancesUrl = () => L.url('admin/network/unravel/instances');

function ownedSection(parent, tab, sectionClass, type, title, description) {
	const o = parent.taboption(tab, form.SectionValue, '_' + type, sectionClass, type, title, description);
	const s = o.subsection;
	s.anonymous = true;
	s.addremove = true;
	const owner = parent.section;
	s.filter = (section_id) => uci.get('unravel', section_id, 'instance') === owner;
	if (sectionClass === form.TypedSection) {
		s.addbtntitle = _('Add settings');
		s.handleAdd = function() {
			return this.map.save(() => common.addOwnedSection(type, owner), true);
		};
		s.renderSectionAdd = function() {
			return this.cfgsections().length ? E([]) : form.TypedSection.prototype.renderSectionAdd.call(this);
		};
	}
	return s;
}

function flag(s, name, title, def, description) {
	const o = s.option(form.Flag, name, title, description);
	o.default = def;
	return o;
}

function value(s, name, title, placeholder, datatype, description) {
	const o = s.option(form.Value, name, title, description);
	o.placeholder = placeholder;
	if (datatype)
		o.datatype = datatype;
	return o;
}

const PROTOCOLS = [
	[ 'irtt', _('IRTT') ],
	[ 'icmp-timestamps', _('ICMP timestamps') ],
	[ 'icmp-echo', _('ICMP echo') ]
];

function reflectorSection(instance, type, title, description) {
	const s = ownedSection(instance, 'reflectors', form.GridSection, type, title, description);
	s.sortable = true;
	s.nodescriptions = true;
	// Saving the row reloads the detail form. Stage its inputs before
	// opening the row dialog so those edits survive the reload.
	s.renderMoreOptionsModal = function(section_id, ev) {
		return this.map.save(null, true).then(() =>
			form.GridSection.prototype.renderMoreOptionsModal.call(this, section_id, ev));
	};
	s.handleAdd = function() {
		return this.map.save(null, true).then(() => {
			const section_id = common.addOwnedSection(type, instance.section);
			this.map.addedSection = section_id;
			return form.GridSection.prototype.renderMoreOptionsModal.call(this, section_id);
		});
	};

	let o = s.option(form.Value, 'host', _('Host'));
	o.datatype = 'host';
	o.rmempty = false;

	o = s.option(form.MultiValue, 'protocols', _('Protocols'),
		_('What the host answers. ICMP uses IPv4 only; IRTT works over IPv4 and IPv6.'));
	for (const [ v, t ] of PROTOCOLS)
		o.value(v, t);
	o.rmempty = false;
	o.create = false;

	o = s.option(form.Value, 'country', _('Country'));
	o.placeholder = _('any');
	o.validate = (section_id, v) =>
		(v == null || v === '' || /^[A-Za-z]{2}$/.test(v)) ? true : _('Expecting a two-letter country code');
	o.textvalue = (section_id) => uci.get('unravel', section_id, 'country') ?? '-';

	o = s.option(form.Value, 'irtt_port', _('IRTT port'));
	o.datatype = 'port';
	o.placeholder = '2112';
	o.depends({ protocols: 'irtt', '!contains': true });
	o.modalonly = true;

	o = s.option(form.Value, 'irtt_hmac', _('IRTT HMAC key'),
		_('Leave empty for unauthenticated sessions.'));
	o.password = true;
	o.depends({ protocols: 'irtt', '!contains': true });
	o.modalonly = true;

	return s;
}

function renderInstance(name, devices) {
	const m = new form.Map('unravel', _('unRAVEL instance: %s').format(name));
	const instance = m.section(form.NamedSection, name, 'instance');
	let s, o;

	instance.tab('general', _('General'));
	instance.tab('law', _('Control law'));
	instance.tab('reflectors', _('Reflectors'));
	instance.tab('output', _('Output'));
	instance.tab('observability', _('Observability'));

	generalFields(instance, devices);
	s = ownedSection(instance, 'law', form.TypedSection, 'law', null,
		_('The control law decides the shaper rates from the delay and load measurements.'));
	common.addLawFields(s);

	// Reflector selection
	s = ownedSection(instance, 'reflectors', form.TypedSection, 'reflectors', _('Reflector selection'),
		_('How many reflectors are used and where they come from.'));

	o = s.option(form.DynamicList, 'files', _('Reflector files'),
		_('CSV inventories to load, in addition to the inline reflectors below. Empty means the packaged <code>/etc/unravel/reflectors.csv</code>.'));
	o.placeholder = '/etc/unravel/reflectors.csv';
	o.datatype = 'string';
	o.depends('_load_files', '1');
	o.retain = true;
	o.cfgvalue = function(section_id) {
		const v = uci.get('unravel', section_id, 'files');
		return (v === 'none') ? [] : L.toArray(v);
	};
	o.validate = (section_id, v) =>
		(v == null || v === '' || v[0] === '/') ? true : _('Expecting an absolute path');

	// UCI drops empty options, so unravel takes `option files 'none'` to
	// mean "load no files". This is declared after `files` so that, on
	// save, the list is written before this decides about `none`.
	o = s.option(form.Flag, '_load_files', _('Load reflector files'),
		_('Off: use only the built-in bootstrap hosts and the inline reflectors below.'));
	o.default = '1';
	o.cfgvalue = (section_id) =>
		(uci.get('unravel', section_id, 'files') === 'none') ? '0' : '1';
	o.write = (section_id, v) => {
		if (v === '0')
			uci.set('unravel', section_id, 'files', 'none');
		else if (uci.get('unravel', section_id, 'files') === 'none')
			uci.unset('unravel', section_id, 'files');
	};
	o.remove = (section_id) => {
		if (uci.get('unravel', section_id, 'files') === 'none')
			uci.unset('unravel', section_id, 'files');
	};

	o = s.option(form.DynamicList, 'countries', _('Countries'),
		_('Only use reflectors from these countries (ISO 3166-1 alpha-2 codes, e.g. <code>NO</code>). Empty means any.'));
	o.validate = (section_id, v) =>
		(v == null || v === '' || /^[A-Za-z]{2}$/.test(v)) ? true : _('Expecting a two-letter country code');

	o = value(s, 'num_reflectors', _('Active reflectors'), '5', 'range(1,255)',
		_('Reflectors whose measurements feed the law.'));

	o = value(s, 'num_candidates', _('Candidates'), '3', 'uinteger',
		_('Reflectors probed in the background to replace failing ones. 0 keeps the startup set fixed and disables protocol fallback. Use at least 2 otherwise.'));
	o.validate = (section_id, v) =>
		(v === '1') ? _('One candidate cannot switch protocols; use 0 or at least 2') : true;

	value(s, 'candidate_period', _('Candidate probe interval (s)'), '3', 'and(ufloat,min(0.001))',
		_('Seconds between probes of each candidate.'));

	// Output
	s = ownedSection(instance, 'output', form.TypedSection, 'output', null,
		_('Logging, and where CSV statistics and saved law state are written.'));

	o = s.option(form.ListValue, 'log_level', _('Log level'));
	for (const l of [ 'error', 'warn', 'info', 'debug', 'trace' ])
		o.value(l);
	o.default = 'info';

	o = flag(s, 'use_syslog', _('Log to syslog'), '1',
		_('Send output to the system log. Read by the init script.'));

	o = value(s, 'folder', _('Output folder'), '/tmp/unravel', 'string',
		_('Statistics and saved law state go under <code>&lt;folder&gt;/&lt;instance&gt;/</code>. Keep it on tmpfs: statistics are written every tick.'));
	o.validate = (section_id, v) =>
		(v == null || v === '' || v[0] === '/') ? true : _('Expecting an absolute path');

	flag(s, 'suppress_statistics', _('Disable CSV statistics'), '0');

	// Observability
	s = ownedSection(instance, 'observability', form.TypedSection, 'observability', null,
		_('Send metrics to a collector accepting InfluxDB line protocol.'));

	o = flag(s, 'enabled', _('Enabled'), '0');

	o = s.option(form.ListValue, 'protocol', _('Protocol'));
	o.value('udp', 'UDP');
	o.value('tcp', 'TCP');
	o.default = 'udp';
	o.depends('enabled', '1');

	o = value(s, 'host', _('Host'), '192.168.1.100', 'host');
	o.depends('enabled', '1');
	o.rmempty = false;

	o = value(s, 'port', _('Port'), '8089', 'port');
	o.depends('enabled', '1');
	o.validate = (section_id, v) => (v === '0') ? _('Must be greater than 0') : true;

	o = value(s, 'batch_size', _('Batch size'), '25', 'and(uinteger,min(1))');
	o.depends('enabled', '1');

	o = value(s, 'batch_timeout_ms', _('Batch timeout (ms)'), '100', 'and(uinteger,min(1))');
	o.depends('enabled', '1');

	o = value(s, 'host_tag', _('Host tag'), _('router hostname'), 'string',
		_('Value of the <code>host</code> tag on every metric.'));
	o.depends('enabled', '1');

	for (const [ name, title, def ] of [
		[ 'export_rate_metrics', _('Export shaper rates'), '1' ],
		[ 'export_events', _('Export events'), '1' ],
		[ 'export_ping_metrics', _('Export per-probe measurements'), '0' ],
		[ 'export_law_metrics', _('Export law metrics'), '0' ]
	]) {
		o = flag(s, name, title, def);
		o.depends('enabled', '1');
	}

	reflectorSection(instance, 'reflector', _('Additional reflectors'),
		_('Added to this instance\'s inventory from the reflector files.'));
	reflectorSection(instance, 'bootstrap_reflector', _('Bootstrap reflectors'),
		_('The first reflectors tried at startup. Any entry here replaces the built-in set (global.irtt.lochnair.net, 9.9.9.9, 94.140.14.14 and 74.82.42.42).'));

	return m.render().then((node) => E([], [
		E('p', {}, E('a', { href: instancesUrl() }, _('Back to instances'))),
		node
	]));
}

return view.extend({
	load() {
		return Promise.all([
			L.resolveDefault(callNetworkDevices(), {}),
			uci.load('unravel')
		]);
	},

	render([ devices ]) {
		const name = new URLSearchParams(window.location.search).get('instance');
		const selected = name != null ? uci.get('unravel', name) : null;
		if (selected?.['.type'] === 'instance' && !selected['.anonymous'])
			return renderInstance(name, devices);

		const m = new form.Map('unravel', _('unRAVEL instances'),
			_('Each instance controls the CAKE shapers of one WAN and runs as its own process.'));
		const s = m.section(form.GridSection, 'instance', _('Instances'));
		s.anonymous = false;
		s.addremove = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add instance…');
		s.filter = (section_id) => !uci.get('unravel', section_id, '.anonymous');
		s.handleAdd = function(ev, section_id) {
			const valid = common.validateNewName(section_id);
			if (valid !== true) {
				ui.addTimeLimitedNotification(null, E('p', valid), 5000, 'warning');
				return Promise.resolve();
			}
			return form.GridSection.prototype.handleAdd.call(this, ev, section_id);
		};
		s.handleRemove = function(section_id) {
			return this.map.save(() => {
				common.removeOwnedSections(section_id);
				uci.remove('unravel', section_id);
			}, true);
		};
		s.renderMoreOptionsModal = function(section_id, ev) {
			if (this.map.addedSection === section_id)
				return form.GridSection.prototype.renderMoreOptionsModal.call(this, section_id, ev);
			window.location.assign(instancesUrl() + '?instance=' + encodeURIComponent(section_id));
		};
		s.addModalOptions = (section) => {
			section.tab('general', _('General'));
			generalFields(section, devices);
		};

		let o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.default = '1';
		o.editable = true;
		o.modalonly = false;

		for (const { dir, title } of DIRECTIONS) {
			o = s.option(form.DummyValue, '_' + dir, title);
			o.modalonly = false;
			o.textvalue = (section_id) => {
				const iface = uci.get('unravel', section_id, dir + '_interface');
				if (!iface || iface === 'none')
					return E('em', _('not controlled'));
				return '%s · %s'.format(iface,
					common.formatKbits(+uci.get('unravel', section_id, dir + '_base_kbits')));
			};
		}

		o = s.option(form.DummyValue, '_law', _('Law'));
		o.modalonly = false;
		o.textvalue = (section_id) => {
			const law = common.ownedSections('law', section_id)[0]?.type ?? 'sqma';
			return common.LAWS[law]?.title ?? law;
		};

		return m.render();
	}
});
