'use strict';
'require form';
'require uci';
'require view';

const PROTOCOLS = [
	[ 'irtt', _('IRTT') ],
	[ 'icmp-timestamps', _('ICMP timestamps') ],
	[ 'icmp-echo', _('ICMP echo') ]
];

// `reflector` and `bootstrap_reflector` sections are a pool shared by all
// instances; they have the same options (ReflectorDefinition in unravel).
function reflectorSection(m, type, title, description) {
	const s = m.section(form.GridSection, type, title, description);
	s.anonymous = true;
	s.addremove = true;
	s.sortable = true;
	s.nodescriptions = true;

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

return view.extend({
	load() {
		return uci.load('unravel');
	},

	render() {
		const m = new form.Map('unravel', _('unRAVEL reflectors'),
			_('Hosts used to measure delay, shared by all instances. Which and how many are used is set by the reflector selection profile.'));

		reflectorSection(m, 'reflector', _('Additional reflectors'),
			_('Added to the inventory from the reflector files.'));

		reflectorSection(m, 'bootstrap_reflector', _('Bootstrap reflectors'),
			_('The first reflectors tried at startup. Any entry here replaces the built-in set (global.irtt.lochnair.net, 9.9.9.9, 94.140.14.14 and 74.82.42.42).'));

		return m.render();
	}
});
