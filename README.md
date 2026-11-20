# luci-app-unravel

LuCI pages for [unRAVEL](https://github.com/Lochnair/unravel) status and
configuration. Each named instance has General, Control law, Reflectors,
Output and Observability tabs. Reflector inventories, inline reflectors and
bootstrap hosts are configured on the instance that uses them. Optional
settings sections can be added from the corresponding tab. Removing an
instance also removes its owned sections.

Requires unRAVEL's instance-owned UCI schema. The status page uses
`unravel.<name>` on ubus. Graphs and the reflector table also depend on the
`history` and `reflectors` methods.

## Layout

```
htdocs/luci-static/resources/
  unravel/common.js        shared law fields and section ownership
  view/unravel/status.js   service control, graphs and reflectors
  view/unravel/instances.js
root/usr/share/
  luci/menu.d/luci-app-unravel.json   Network → unRAVEL
  rpcd/acl.d/luci-app-unravel.json
```

## Status

Each running instance publishes `status`, `history` and `reflectors` on
ubus at `unravel.<name>`. The page calls them directly every 2 seconds, so no rpcd plugin is
needed. An instance without an object is shown as not running.

`status` is fetched for every instance, since the service controls need it.
`history` and `reflectors` are fetched only for the tab on screen. The
graphs come from unravel's ten-minute history, so they survive a reload.
Each direction has three plots on one time axis: the shaper rate with its
base and minimum, the traffic on its own scale, and the delay the law
reports with its threshold. An unravel without `history` gets the current
figures and a note instead of graphs.

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
