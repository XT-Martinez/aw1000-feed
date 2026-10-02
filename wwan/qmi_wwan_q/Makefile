include $(TOPDIR)/rules.mk

PKG_NAME:=qmi_wwan_q
PKG_VERSION:=1.5.0
PKG_RELEASE:=3

PKG_LICENSE:=GPL-2.0-only

include $(INCLUDE_DIR)/kernel.mk
include $(INCLUDE_DIR)/package.mk

PKG_BUILD_PARALLEL:=1

# Quectel's qmi_wwan_q V1.5.0, taken from FUjr/QModem c49654e
# (driver/quectel_QMI_WWAN), which carries the Linux 6.17+ usbnet bh_work and
# hrtimer_setup changes. Changes: QMI_WWAN_Q_DEFAULT_QMAP_MODE below, and
# qmap netdevs are raw IP even without the rmnet_nss hooks (see below).
#
# Built without its rmnet_nss hooks: on the EDMA tree qca-nss-drv binds every
# raw-IP modem netdev to an rmnet_rx node pair by itself (nss-packages
# 944ea25, patch 0117), and the driver's own hook would claim the same
# rx_handler first.

define KernelPackage/qmi_wwan_q
  SUBMENU:=WWAN Support
  TITLE:=Quectel Linux USB QMI WWAN Driver
  DEPENDS:=+kmod-usb-net +kmod-usb-wdm
  FILES:=$(PKG_BUILD_DIR)/qmi_wwan_q.ko
  AUTOLOAD:=$(call AutoLoad,81,qmi_wwan_q)
  PROVIDES:=kmod-usb-net-qmi-wwan-quectel
endef

define KernelPackage/qmi_wwan_q/description
  Quectel Linux USB QMI WWAN driver with QMAP multiplexing. Each mux
  channel is its own netdev, wwan0_1 .. wwan0_<qmap_mode>.
endef

define KernelPackage/qmi_wwan_q/config
	config QMI_WWAN_Q_QMAP_MODE
		int "Default number of QMAP channels (qmap_mode)"
		depends on PACKAGE_kmod-qmi_wwan_q
		range 0 4
		default 2
		help
		  qmap_mode module parameter default. 2 gives wwan0_1 and wwan0_2,
		  which the quectel proto uses to carry IPv4 and IPv6 as two
		  separate data calls when "multiplexing" is enabled.
endef

# Kbuild no longer reads EXTRA_CFLAGS (6.18), so pass these as ccflags-y;
# the module's own Makefile sets none.
MODULE_CFLAGS += \
	-Wno-unused-function \
	-Wno-missing-prototypes \
	-Wno-missing-declarations \
	-DQMI_WWAN_Q_DEFAULT_QMAP_MODE=$(if $(CONFIG_QMI_WWAN_Q_QMAP_MODE),$(CONFIG_QMI_WWAN_Q_QMAP_MODE),2)

define Build/Compile
	+$(KERNEL_MAKE) ccflags-y="$(MODULE_CFLAGS)" M="$(PKG_BUILD_DIR)" \
		modules
endef

$(eval $(call KernelPackage,qmi_wwan_q))
