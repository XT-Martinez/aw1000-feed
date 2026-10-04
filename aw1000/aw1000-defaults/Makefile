include $(TOPDIR)/rules.mk

PKG_NAME:=aw1000-defaults
PKG_VERSION:=1
PKG_RELEASE:=16
PKG_LICENSE:=GPL-2.0-only

include $(INCLUDE_DIR)/package.mk

define Package/aw1000-defaults
  SECTION:=base
  CATEGORY:=Base system
  TITLE:=Arcadyan AW1000 first-boot defaults
  DEPENDS:=@TARGET_qualcommax_ipq807x_DEVICE_arcadyan_aw1000 \
	+sms-tool +luci-proto-quectel +block-mount
  PKGARCH:=all
endef

define Package/aw1000-defaults/description
  First-boot configuration for the AW1000: LAN address, the modem's
  "wwan" interface (quectel proto, IPv4/IPv6 over separate QMAP channels),
  front panel LEDs, the dashboard's modem widgets and the LuCI theme.
endef

define Package/aw1000-defaults/conffiles
/etc/config/aw1000_leds
endef

define Build/Compile
endef

define Package/aw1000-defaults/install
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_DATA) ./files/etc/uci-defaults/99-zz-aw1000 $(1)/etc/uci-defaults/
	$(INSTALL_DIR) $(1)/etc/config $(1)/etc/init.d $(1)/etc/hotplug.d/tty $(1)/usr/sbin
	$(INSTALL_CONF) ./files/etc/config/aw1000_leds $(1)/etc/config/
	$(INSTALL_BIN) ./files/etc/init.d/aw1000-leds $(1)/etc/init.d/
	$(INSTALL_DATA) ./files/etc/hotplug.d/tty/30-aw1000-modem-ports $(1)/etc/hotplug.d/tty/
	$(INSTALL_BIN) ./files/usr/sbin/aw1000-leds ./files/usr/sbin/aw1000-modem-ports $(1)/usr/sbin/
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/usr/share/rpcd/acl.d/luci-aw1000-dashboard.json $(1)/usr/share/rpcd/acl.d/
	$(INSTALL_DIR) $(1)/www/luci-static/resources/aw1000
	$(INSTALL_DATA) ./files/www/luci-static/resources/aw1000/cell.js ./files/www/luci-static/resources/aw1000/mcc.js \
		$(1)/www/luci-static/resources/aw1000/
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/dashboard/include $(1)/www/luci-static/resources/view/dashboard/icons
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/dashboard/include/40_mobile.js ./files/www/luci-static/resources/view/dashboard/include/45_thermal.js ./files/www/luci-static/resources/view/dashboard/include/48_nss.js $(1)/www/luci-static/resources/view/dashboard/include/
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/dashboard/icons/mobile.svg ./files/www/luci-static/resources/view/dashboard/icons/thermal.svg ./files/www/luci-static/resources/view/dashboard/icons/nss.svg $(1)/www/luci-static/resources/view/dashboard/icons/
endef

$(eval $(call BuildPackage,aw1000-defaults))
