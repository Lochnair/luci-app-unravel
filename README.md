# luci-app-unravel

LuCI pages for [unRAVEL](https://github.com/Lochnair/unravel): instances,
profiles (law, reflector selection, output, metrics export, advanced),
reflectors, and a status page.

Matches the UCI schema on unravel `master` (ffdcce8): multiple instances,
the sqma and script laws, and per-instance probe binding. The status page
needs the ubus status from unravel's `feat/ubus` branch. The single-WAN default config, with anonymous
sections, shows up as the "unnamed" instance and profiles.

## Layout

```
htdocs/luci-static/resources/
  unravel/common.js        shared: law fields, references, name checks
  view/unravel/status.js   service control, live rates and traffic
  view/unravel/instances.js
  view/unravel/profiles.js
  view/unravel/reflectors.js
root/usr/share/
  luci/menu.d/luci-app-unravel.json   Network → unRAVEL
  rpcd/acl.d/luci-app-unravel.json
```

## Status

Each running instance publishes `status` on ubus, as `unravel` for the
unnamed instance and `unravel.<name>` for a named one. The page polls those
directly every 2 seconds, so no rpcd plugin is needed. An instance without
an object is shown as not running. The charts are drawn from the samples
the page has collected since it was opened.

## Trying it on a router

```sh
scp -r htdocs/luci-static/resources/* root@router:/www/luci-static/resources/
scp -r root/* root@router:/
ssh root@router 'rm -rf /tmp/luci-*; service rpcd restart'
```

Then reload LuCI and log in again so the new ACL applies.

## Building

As part of a feed, next to the `unravel` package, with the LuCI feed
installed: `make package/luci-app-unravel/compile`.
