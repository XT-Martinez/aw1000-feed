include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-aw1000-modem
PKG_VERSION:=1
PKG_RELEASE:=3
PKG_LICENSE:=GPL-2.0-only

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-aw1000-modem
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=AW1000 modem pages: SMS, bands, cell lock, AT commands
  DEPENDS:=+luci-base +rpcd +sms-tool +aw1000-defaults
endef

define Package/luci-app-aw1000-modem/description
  LuCI pages for the AW1000's Quectel RG500Q: SMS conversations, LTE/5G band
  preferences, cell scan and cell lock, and an AT command console. The
  backend (rpcd luci.aw1000-modem) talks to the modem's first AT port with
  aw1000-at, which waits as long as a command needs. Cell locks are kept in
  /etc/config/aw1000_modem, where the quectel proto picks them up.
endef

define Package/luci-app-aw1000-modem/conffiles
/etc/config/aw1000_modem
/etc/aw1000-modem/
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CPPFLAGS) $(TARGET_CFLAGS) -Wall $(TARGET_LDFLAGS) \
		-o $(PKG_BUILD_DIR)/aw1000-at ./src/aw1000-at.c
endef

define Package/luci-app-aw1000-modem/install
	$(INSTALL_DIR) $(1)/etc/config $(1)/etc/uci-defaults
	$(INSTALL_CONF) ./files/etc/config/aw1000_modem $(1)/etc/config/
	$(INSTALL_BIN) ./files/etc/uci-defaults/50-aw1000-modem $(1)/etc/uci-defaults/
	$(INSTALL_DIR) $(1)/usr/bin $(1)/usr/libexec/rpcd $(1)/usr/share/luci/menu.d $(1)/usr/share/rpcd/acl.d
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/aw1000-at $(1)/usr/bin/
	$(INSTALL_BIN) ./files/usr/libexec/rpcd/luci.aw1000-modem $(1)/usr/libexec/rpcd/
	$(INSTALL_DATA) ./files/usr/share/luci/menu.d/luci-app-aw1000-modem.json $(1)/usr/share/luci/menu.d/
	$(INSTALL_DATA) ./files/usr/share/rpcd/acl.d/luci-app-aw1000-modem.json $(1)/usr/share/rpcd/acl.d/
	$(INSTALL_DIR) $(1)/www/luci-static/resources/aw1000 $(1)/www/luci-static/resources/view/aw1000-modem
	$(INSTALL_DATA) ./files/www/luci-static/resources/aw1000/modem.js ./files/www/luci-static/resources/aw1000/modem.css \
		./files/www/luci-static/resources/aw1000/plmn.js \
		$(1)/www/luci-static/resources/aw1000/
	$(INSTALL_DATA) ./files/www/luci-static/resources/view/aw1000-modem/*.js $(1)/www/luci-static/resources/view/aw1000-modem/
endef

define Package/luci-app-aw1000-modem/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/* 2>/dev/null
	/etc/init.d/rpcd reload
}
exit 0
endef

$(eval $(call BuildPackage,luci-app-aw1000-modem))
