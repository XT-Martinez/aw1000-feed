include $(TOPDIR)/rules.mk

PKG_NAME:=quectel-cm
PKG_VERSION:=1.6.5
PKG_RELEASE:=20

PKG_LICENSE:=GPL-2.0-only

# From xhikarishii/nss-packages (aw1000-nss): quectel-cm 1.6.5 with the
# netifd "quectel" proto, QMAP IPv4/IPv6 split, passthrough and NAT64.
# Upstream qmi_wwan is deliberately not pulled in: it matches the same
# Quectel IDs and whichever module probes first owns the modem.

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/cmake.mk

# CMakeLists.txt asks for CMake 2.4; CMake 4 dropped compatibility below 3.5.
CMAKE_OPTIONS += -DCMAKE_POLICY_VERSION_MINIMUM=3.5

define Package/quectel-cm
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=WWAN
  TITLE:=Qconnector Manager for Quectel WWAN modules
  DEPENDS:= \
    +kmod-qmi_wwan_q \
    +kmod-usb-serial-option \
    +sms-tool
endef

define Package/quectel-cm/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/usr/bin/quectel-CM $(1)/usr/bin/quectel-cm
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/usr/bin/quectel-{mbim,qmi}-proxy $(1)/usr/bin/

	$(INSTALL_DIR) $(1)/lib/netifd/proto
	$(INSTALL_BIN) ./files/quectel.sh $(1)/lib/netifd/proto/

	$(INSTALL_DIR) $(1)/usr/share/quectel
	$(INSTALL_BIN) ./files/quectel-monitor.sh $(1)/usr/share/quectel/quectel-monitor

	$(INSTALL_DIR) $(1)/etc/hotplug.d/quectel
	$(INSTALL_BIN) ./files/nat64-pref64.sh $(1)/etc/hotplug.d/quectel/10-nat64-pref64

	$(INSTALL_DIR) $(1)/etc/hotplug.d/net
	$(INSTALL_BIN) ./files/smp-affinity-mhi-pcie.sh $(1)/etc/hotplug.d/net/21-smp-affinity-mhi-pcie
	$(INSTALL_BIN) ./files/smp-affinity-qmi-usb.sh $(1)/etc/hotplug.d/net/22-smp-affinity-qmi-usb
endef

$(eval $(call BuildPackage,quectel-cm))
