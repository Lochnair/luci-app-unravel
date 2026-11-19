# SPDX-License-Identifier: Apache-2.0

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for unRAVEL
LUCI_DESCRIPTION:=Configure unRAVEL instances, laws and reflectors
LUCI_DEPENDS:=+luci-base +unravel
LUCI_PKGARCH:=all

PKG_MAINTAINER:=Nils Andreas Svee <me@lochnair.net>
PKG_LICENSE:=Apache-2.0

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
