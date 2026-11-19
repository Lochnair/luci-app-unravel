'use strict';
'require form';
'require rpc';
'require uci';
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

return view.extend({
	load() {
		return Promise.all([
			L.resolveDefault(callNetworkDevices(), {}),
			uci.load('unravel')
		]);
	},

	render([ devices ]) {
		let m, s, o;

		m = new form.Map('unravel', _('unRAVEL instances'),
			_('Each instance controls the CAKE shapers of one WAN and runs as its own process. ' +
			  'An instance uses the profiles it names; anything it does not name uses built-in defaults. ' +
			  'The unnamed instance from the default config uses the unnamed section of each type instead.'));

		s = m.section(form.GridSection, 'network', _('Instances'));
		s.anonymous = false;
		s.addremove = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add instance…');
		s.sectiontitle = (section_id) =>
			uci.get('unravel', section_id, '.anonymous') ? _('Unnamed (default)') : section_id;
		common.guardSection(s);

		s.tab('general', _('General'));
		s.tab('profiles', _('Profiles'));
		s.tab('probes', _('Probes'));

		o = s.taboption('general', form.Flag, 'enabled', _('Enabled'));
		o.default = '1';
		o.editable = true;

		for (const { dir, title } of DIRECTIONS) {
			o = s.taboption('general', form.Value, dir + '_interface', _('%s interface').format(title),
				dir === 'download'
					? _('Device with the CAKE qdisc shaping downloads, usually the IFB (e.g. <code>ifb4wan</code>). <code>none</code> leaves this direction alone.')
					: _('Device with the CAKE qdisc shaping uploads, usually the WAN device. <code>none</code> leaves this direction alone.'));
			o.value('none', _('none (not controlled)'));
			for (const name of Object.keys(devices).filter((n) => n !== 'lo').sort())
				o.value(name);
			o.rmempty = false;
			o.modalonly = true;
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
			o.modalonly = true;
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
			o.modalonly = true;
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
			o.modalonly = true;

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

		for (const { type, title } of common.PROFILE_TYPES) {
			o = s.taboption('profiles', form.ListValue, type, title);
			o.value('', _('Not set'));
			for (const p of uci.sections('unravel', type))
				if (!p['.anonymous'])
					o.value(p['.name'], p['.name']);
			o.description = _('Not set: built-in defaults for a named instance, the unnamed %s section for the unnamed instance.').format(type);
			o.modalonly = true;
		}

		// Read by unravel's ICMP and IRTT probes. measurement_fib exists too,
		// but only applies on FreeBSD.
		o = s.taboption('probes', form.Value, 'measurement_bind_device', _('Bind probes to device'),
			_('Send this instance\'s probes out of this device only (SO_BINDTODEVICE). Useful with several WANs. Empty uses the routing table.'));
		o.value('', _('Not set'));
		for (const name of Object.keys(devices).filter((n) => n !== 'lo').sort())
			o.value(name);
		o.modalonly = true;

		o = s.taboption('probes', form.Value, 'measurement_mark', _('Probe firewall mark'),
			_('Set this mark (SO_MARK) on the probes, for policy routing such as mwan3 or pbr. Decimal.'));
		o.datatype = 'uinteger';
		o.validate = (section_id, v) =>
			(v == null || v === '' || +v <= 4294967295) ? true : _('Must fit in 32 bits');
		o.modalonly = true;

		o = s.option(form.DummyValue, '_law', _('Law'));
		o.modalonly = false;
		o.textvalue = (section_id) => {
			const sec = uci.get('unravel', section_id);
			const ref = sec.law;
			let law;
			if (ref)
				law = uci.get('unravel', ref, 'type');
			else if (sec['.anonymous'])
				law = (uci.sections('unravel', 'law').find((l) => l['.anonymous']) ?? {}).type;
			law = law ?? 'sqma';
			const label = common.LAWS[law]?.title ?? law;
			return ref ? '%s (%s)'.format(ref, label) : label;
		};

		return m.render();
	}
});
