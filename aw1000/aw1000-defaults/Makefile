include $(TOPDIR)/rules.mk

PKG_NAME:=aw1000-defaults
PKG_VERSION:=1
PKG_RELEASE:=2
PKG_LICENSE:=GPL-2.0-only

include $(INCLUDE_DIR)/package.mk

define Package/aw1000-defaults
  SECTION:=base
  CATEGORY:=Base system
  TITLE:=Arcadyan AW1000 first-boot defaults
  DEPENDS:=@TARGET_qualcommax_ipq807x_DEVICE_arcadyan_aw1000 \
	+qmodem +jq +luci-proto-quectel +block-mount
  PKGARCH:=all
endef

define Package/aw1000-defaults/description
  First-boot configuration for the AW1000: LAN address, the modem's
  "wwan" interface (quectel proto, IPv4/IPv6 over separate QMAP channels),
  QModem as a monitor only, front panel LEDs and the LuCI theme.
endef

define Build/Compile
endef

define Package/aw1000-defaults/install
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_DATA) ./files/etc/uci-defaults/99-zz-aw1000 $(1)/etc/uci-defaults/
	$(INSTALL_DIR) $(1)/usr/share/qmodem/led_scripts
	$(INSTALL_BIN) ./files/usr/share/qmodem/led_scripts/aw1000.sh $(1)/usr/share/qmodem/led_scripts/
endef

$(eval $(call BuildPackage,aw1000-defaults))
