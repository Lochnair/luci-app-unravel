'use strict';
'require baseclass';
'require form';
'require ui';
'require uci';

// Section types a `network` section (an instance) can point at by name, with
// the option on the instance that holds the reference. They match the
// sections of the UCI schema in unravel's src/settings/mod.rs.
const PROFILE_TYPES = [
	{ type: 'law', title: _('Law') },
	{ type: 'reflectors', title: _('Reflector selection') },
	{ type: 'output', title: _('Output') },
	{ type: 'observability', title: _('Metrics export') },
	{ type: 'advanced_settings', title: _('Advanced') }
];

// Built-in laws. Each field is one UCI option in the `law` section, shown
// only while `type` is that law. LuCI removes the options of inactive fields
// on save, so switching law leaves none of the old law's options behind,
// which unravel would reject.
//
// Defaults and ranges follow SqmaSettings in unravel's src/law/sqma.rs.
const LAWS = {
	sqma: {
		title: _('SQMA'),
		fields: [
			{ name: 'download_delay_ms', title: _('Download delay threshold'), unit: 'ms',
			  default: '15', datatype: 'ufloat',
			  description: _('Delay above baseline at which the download rate is cut.') },
			{ name: 'upload_delay_ms', title: _('Upload delay threshold'), unit: 'ms',
			  default: '15', datatype: 'ufloat',
			  description: _('Delay above baseline at which the upload rate is cut.') },
			{ name: 'high_load_level', title: _('High load level'),
			  default: '0.8', datatype: 'ufloat',
			  description: _('Fraction of the current rate in use above which the link counts as loaded, and the rate may be raised.') },
			{ name: 'tick_interval', title: _('Tick interval'), unit: 's',
			  default: '0.5', datatype: 'and(ufloat,min(0.001))',
			  description: _('How often reflectors are probed and traffic is sampled.') },
			{ name: 'min_change_interval', title: _('Minimum change interval'), unit: 's',
			  default: '0.5', datatype: 'and(ufloat,min(0.001))',
			  description: _('Shortest time between two rate changes.') },
			{ name: 'speed_hist_size', title: _('Speed history size'),
			  default: '100', datatype: 'and(uinteger,min(1))',
			  description: _('Number of known-good rates remembered per direction.') },
			{ name: 'low_load_level', title: _('Low load level'),
			  default: '0.3', datatype: 'range(0,1)',
			  description: _('Load at or below which the cut floor and idle recovery act.') },
			{ name: 'low_load_cut_floor', title: _('Low load cut floor'),
			  default: '0', datatype: 'and(ufloat,max(0.999999))',
			  description: _('At low load, a single cut never takes the rate below this fraction of the current rate. 0 turns it off.') },
			{ name: 'idle_recovery_percent', title: _('Idle recovery'), unit: '%',
			  default: '0', datatype: 'range(0,100)',
			  description: _('At low load and delay below the threshold, step the rate towards the median known-good rate by this percentage of the base rate per change. 0 turns it off.') },
			{ name: 'save_history', title: _('Keep history across restarts'), flag: true,
			  default: '0',
			  description: _('Save the known-good rates in the output folder and read them back at startup if they are under 6 hours old.') }
		]
	},
	script: {
		title: _('Script'),
		fields: [
			{ name: 'path', title: _('Script'), required: true,
			  placeholder: '/etc/unravel/law.lua',
			  validate: (v) => (v == null || v === '' || /^\/.+\.lua$/.test(v))
				? true : _('Expecting an absolute path to a .lua file'),
			  description: _('Lua script implementing the law. Needs an unravel build with script support.') }
		],
		// Every other option in the section is the script's own configuration.
		freeform: true
	}
};

const LAW_OPTIONS_RESERVED = [ 'type', 'path' ];

// The instance name unravel and the init script use: the section name of a
// named `network` section, `default` for the anonymous one.
function instanceName(section_id) {
	const s = uci.get('unravel', section_id);
	return (s && s['.anonymous']) ? 'default' : section_id;
}

// Names are shared by all section types in a package, and `default` is the
// unnamed instance's name. `--instance` accepts letters, digits and `_`,
// which is exactly what `uciname` allows.
function validateNewName(name) {
	if (name == null || name === '')
		return _('Expecting: %s').format(_('non-empty value'));

	if (!/^[A-Za-z0-9_]+$/.test(name))
		return _('Use only letters, digits and underscores');

	if (name === 'default')
		return _('"default" is reserved for the unnamed instance');

	if (uci.get('unravel', name) != null)
		return _('A section called "%s" already exists').format(name);

	return true;
}

// `network` sections whose `option <type>` names this section.
function referencesTo(type, name) {
	return uci.sections('unravel', 'network')
		.filter((s) => s[type] === name)
		.map((s) => instanceName(s['.name']));
}

function referenceLabel(type, section_id) {
	const s = uci.get('unravel', section_id);
	if (!s)
		return '?';
	return s['.anonymous'] ? _('Unnamed') : section_id;
}

// Adds the "add" name check and the "in use" delete check to a section that
// edits a referenced type. Works for TypedSection and GridSection.
function guardSection(section) {
	const handleAdd = section.handleAdd;
	const handleRemove = section.handleRemove;

	section.handleAdd = function(ev, name) {
		if (!this.anonymous) {
			const valid = validateNewName(name);
			if (valid !== true) {
				ui.addTimeLimitedNotification(null, E('p', valid), 5000, 'warning');
				return Promise.resolve();
			}
		}
		return handleAdd.apply(this, arguments);
	};

	section.handleRemove = function(section_id) {
		const users = referencesTo(this.sectiontype, section_id);
		if (users.length) {
			ui.addTimeLimitedNotification(null, E('p',
				_('"%s" is used by %s. Point those instances elsewhere first.')
					.format(section_id, users.join(', '))), 7000, 'warning');
			return Promise.resolve();
		}
		return handleRemove.apply(this, arguments);
	};

	return section;
}

function addLawFields(s, tab) {
	const opt = (cls, name, title) =>
		tab ? s.taboption(tab, cls, name, title) : s.option(cls, name, title);

	let o = opt(form.ListValue, 'type', _('Law'));
	for (const name in LAWS)
		o.value(name, LAWS[name].title);
	o.default = 'sqma';
	o.rmempty = false;
	o.modalonly = true;

	for (const law in LAWS) {
		for (const f of LAWS[law].fields) {
			if (f.flag) {
				o = opt(form.Flag, f.name, f.title);
				o.default = f.default;
			}
			else {
				o = opt(form.Value, f.name, f.unit ? '%s (%s)'.format(f.title, f.unit) : f.title);
				o.placeholder = f.placeholder ?? f.default;
				if (f.datatype)
					o.datatype = f.datatype;
				if (f.validate)
					o.validate = (section_id, value) => f.validate(value);
				o.rmempty = !f.required;
			}
			o.description = f.description;
			o.depends('type', law);
			o.modalonly = true;
		}

		if (LAWS[law].freeform) {
			o = opt(FreeformOptions, '_freeform', _('Script options'));
			o.description = _('One option per line as <code>name = value</code>. Repeat a name to make a list. These are passed to the script\'s <code>init</code> as its config.');
			o.depends('type', law);
			o.modalonly = true;
		}
	}
}

// Edits every option of a `law` section that is not one of the selected
// law's fields, as `name = value` lines. A script law takes arbitrary
// options, so they cannot be fixed form fields.
const FreeformOptions = form.TextValue.extend({
	__init__() {
		this.super('__init__', arguments);
		this.rows = 6;
		this.monospace = true;
		this.optional = true;
	},

	_extraOptions(section_id) {
		const s = uci.get('unravel', section_id) ?? {};
		const law = LAWS[s.type];
		const known = new Set(LAW_OPTIONS_RESERVED.concat(law ? law.fields.map((f) => f.name) : []));
		return Object.keys(s).filter((k) => k[0] !== '.' && !known.has(k)).sort();
	},

	cfgvalue(section_id) {
		const s = uci.get('unravel', section_id) ?? {};
		const lines = [];
		for (const k of this._extraOptions(section_id)) {
			for (const v of L.toArray(s[k]))
				lines.push('%s = %s'.format(k, v));
		}
		return lines.join('\n');
	},

	_parse(value) {
		const opts = {};
		const lines = (value ?? '').split(/\n/);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line === '' || line[0] === '#')
				continue;
			const m = line.match(/^([a-z0-9_]+)\s*=\s*(.*)$/);
			if (!m)
				return _('Line %d: expecting name = value, with a lowercase snake_case name').format(i + 1);
			if (LAW_OPTIONS_RESERVED.includes(m[1]))
				return _('Line %d: "%s" is set above').format(i + 1, m[1]);
			if (m[2] === '')
				return _('Line %d: UCI cannot store an empty value').format(i + 1);
			(opts[m[1]] = opts[m[1]] ?? []).push(m[2]);
		}
		return opts;
	},

	validate(section_id, value) {
		const parsed = this._parse(value);
		return (typeof parsed === 'string') ? parsed : true;
	},

	write(section_id, value) {
		const opts = this._parse(value);
		if (typeof opts === 'string')
			return;
		for (const k of this._extraOptions(section_id))
			if (!(k in opts))
				uci.unset('unravel', section_id, k);
		for (const k in opts)
			uci.set('unravel', section_id, k, opts[k].length > 1 ? opts[k] : opts[k][0]);
	},

	remove(section_id) {
		for (const k of this._extraOptions(section_id))
			uci.unset('unravel', section_id, k);
	}
});

function formatKbits(kbits) {
	if (kbits == null || isNaN(kbits))
		return '-';
	if (kbits >= 1000000)
		return '%.2f Gbit/s'.format(kbits / 1000000);
	if (kbits >= 1000)
		return '%.1f Mbit/s'.format(kbits / 1000);
	return '%d kbit/s'.format(kbits);
}

return baseclass.extend({
	PROFILE_TYPES,
	LAWS,
	FreeformOptions,
	instanceName,
	validateNewName,
	referencesTo,
	referenceLabel,
	guardSection,
	addLawFields,
	formatKbits
});
