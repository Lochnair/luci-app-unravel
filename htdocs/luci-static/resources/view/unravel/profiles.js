'use strict';
'require form';
'require uci';
'require view';
'require unravel.common as common';

// One grid per profile type. A profile is a named section that instances
// point at, so several WANs can share one; editing it changes every
// instance that uses it.
function profileSection(m, type, title, description) {
	const s = m.section(form.GridSection, type, title, description);
	s.anonymous = false;
	s.addremove = true;
	s.nodescriptions = true;
	s.addbtntitle = _('Add profile…');
	s.sectiontitle = (section_id) =>
		uci.get('unravel', section_id, '.anonymous') ? _('Unnamed (default)') : section_id;
	common.guardSection(s);

	const o = s.option(form.DummyValue, '_users', _('Used by'));
	o.modalonly = false;
	o.textvalue = (section_id) => {
		const users = common.referencesTo(type, section_id);
		if (uci.get('unravel', section_id, '.anonymous')) {
			const anon = uci.sections('unravel', 'network')
				.filter((n) => n['.anonymous'] && !n[type]);
			if (anon.length)
				users.unshift(_('unnamed instance'));
		}
		return users.length ? users.join(', ') : E('em', _('nothing'));
	};

	return s;
}

function flag(s, name, title, def, description) {
	const o = s.option(form.Flag, name, title, description);
	o.default = def;
	o.modalonly = true;
	return o;
}

function value(s, name, title, placeholder, datatype, description) {
	const o = s.option(form.Value, name, title, description);
	o.placeholder = placeholder;
	if (datatype)
		o.datatype = datatype;
	o.modalonly = true;
	return o;
}

return view.extend({
	load() {
		return uci.load('unravel');
	},

	render() {
		let m, s, o;

		m = new form.Map('unravel', _('unRAVEL profiles'),
			_('Settings shared by reference. An instance picks one profile of each type on the Instances page. Changing a profile affects every instance using it.'));
		m.tabbed = true;

		// Law
		s = profileSection(m, 'law', _('Laws'),
			_('The control law decides the shaper rates from the delay and load measurements.'));
		common.addLawFields(s);
		o = s.option(form.DummyValue, '_type', _('Law'));
		o.modalonly = false;
		o.textvalue = (section_id) => {
			const t = uci.get('unravel', section_id, 'type') ?? 'sqma';
			const path = uci.get('unravel', section_id, 'path');
			const title = common.LAWS[t]?.title ?? t;
			return (t === 'script' && path) ? '%s: %s'.format(title, path) : title;
		};

		// Reflector selection
		s = profileSection(m, 'reflectors', _('Reflector selection'),
			_('How many reflectors are used and where they come from. The reflectors themselves are on the Reflectors page.'));

		o = s.option(form.DynamicList, 'files', _('Reflector files'),
			_('CSV inventories to load, in addition to the reflectors on the Reflectors page. Empty means the packaged <code>/etc/unravel/reflectors.csv</code>.'));
		o.placeholder = '/etc/unravel/reflectors.csv';
		o.datatype = 'string';
		o.depends('_load_files', '1');
		o.retain = true;
		o.modalonly = true;
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
			_('Off: use only the built-in bootstrap hosts and the reflectors on the Reflectors page.'));
		o.default = '1';
		o.modalonly = true;
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
		o.modalonly = true;
		o.validate = (section_id, v) =>
			(v == null || v === '' || /^[A-Za-z]{2}$/.test(v)) ? true : _('Expecting a two-letter country code');

		o = value(s, 'num_reflectors', _('Active reflectors'), '5', 'range(1,255)',
			_('Reflectors whose measurements feed the law.'));
		o.modalonly = null;

		o = value(s, 'num_candidates', _('Candidates'), '3', 'uinteger',
			_('Reflectors probed in the background to replace failing ones. 0 keeps the startup set fixed and disables protocol fallback. Use at least 2 otherwise.'));
		o.modalonly = null;
		o.validate = (section_id, v) =>
			(v === '1') ? _('One candidate cannot switch protocols; use 0 or at least 2') : true;

		value(s, 'candidate_period', _('Candidate probe interval (s)'), '3', 'and(ufloat,min(0.001))',
			_('Seconds between probes of each candidate.'));

		// Output
		s = profileSection(m, 'output', _('Output'),
			_('Logging, and where CSV statistics and saved law state are written.'));

		o = s.option(form.ListValue, 'log_level', _('Log level'));
		for (const l of [ 'error', 'warn', 'info', 'debug', 'trace' ])
			o.value(l);
		o.default = 'info';
		o.modalonly = null;

		o = flag(s, 'use_syslog', _('Log to syslog'), '1',
			_('Send output to the system log. Read by the init script.'));

		o = value(s, 'folder', _('Output folder'), '/tmp/unravel', 'string',
			_('Statistics and saved law state go under <code>&lt;folder&gt;/&lt;instance&gt;/</code>. Keep it on tmpfs: statistics are written every tick.'));
		o.validate = (section_id, v) =>
			(v == null || v === '' || v[0] === '/') ? true : _('Expecting an absolute path');

		flag(s, 'suppress_statistics', _('Disable CSV statistics'), '0');

		// Observability
		s = profileSection(m, 'observability', _('Metrics export'),
			_('Send metrics to a collector accepting InfluxDB line protocol.'));

		o = flag(s, 'enabled', _('Enabled'), '0');
		o.modalonly = null;
		o.editable = true;

		o = s.option(form.ListValue, 'protocol', _('Protocol'));
		o.value('udp', 'UDP');
		o.value('tcp', 'TCP');
		o.default = 'udp';
		o.depends('enabled', '1');
		o.modalonly = true;

		o = value(s, 'host', _('Host'), '192.168.1.100', 'host');
		o.depends('enabled', '1');
		o.rmempty = false;
		o.modalonly = null;

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

		// Advanced
		s = profileSection(m, 'advanced_settings', _('Advanced'));

		o = flag(s, 'dry_run', _('Dry run'), '0',
			_('Measure and decide, but never change the shapers. Still needs the interfaces and CAKE qdiscs to exist.'));
		o.modalonly = null;

		return m.render();
	}
});
