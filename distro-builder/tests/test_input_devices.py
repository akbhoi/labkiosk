#!/usr/bin/env python3
"""
Is a keyboard attached, is there a touchscreen? (the on-screen keyboard)

The kiosk bar opens its on-screen keyboard by itself when the agent reports
keyboardPresent: false, so a power button or a laptop's hotkey device taken for
a keyboard leaves a touch-only workstation unable to type, and a touchpad taken
for a touchscreen does nothing worse than show a keyboard nobody asked for.
The samples are /proc/bus/input/devices as real machines print it.

    PYTHONPYCACHEPREFIX=/tmp/pyc python3 -m unittest discover -s distro-builder/tests
"""

import importlib.machinery
import importlib.util
import os
import re
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROOT = os.path.join(ROOT, "config", "includes.chroot")
REPO = os.path.dirname(ROOT)


def load(name, path):
    """Import a module by path, including the ones with no .py suffix."""
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


agent = load("labkiosk_agent_input", os.path.join(CHROOT, "opt/labkiosk/agent/agent.py"))
LOGGED = []
agent.log = LOGGED.append

POWER_BUTTONS = """\
I: Bus=0019 Vendor=0000 Product=0001 Version=0000
N: Name="Power Button"
P: Phys=PNP0C0C/button/input0
S: Sysfs=/devices/LNXSYSTM:00/LNXSYBUS:00/PNP0C0C:00/input/input0
U: Uniq=
H: Handlers=kbd event0
B: PROP=0
B: EV=3
B: KEY=10000000000000 0

I: Bus=0019 Vendor=0000 Product=0001 Version=0000
N: Name="Power Button"
P: Phys=LNXPWRBN/button/input0
S: Sysfs=/devices/LNXSYSTM:00/LNXPWRBN:00/input/input1
U: Uniq=
H: Handlers=kbd event1
B: PROP=0
B: EV=3
B: KEY=10000000000000 0
"""

VIDEO_BUS = """\
I: Bus=0019 Vendor=0000 Product=0006 Version=0000
N: Name="Video Bus"
P: Phys=LNXVIDEO/video/input0
S: Sysfs=/devices/LNXSYSTM:00/LNXSYBUS:00/PNP0A08:00/LNXVIDEO:00/input/input4
U: Uniq=
H: Handlers=kbd event4
B: PROP=0
B: EV=3
B: KEY=3e000b00000000 0 0 0
"""

PC_SPEAKER = """\
I: Bus=0010 Vendor=001f Product=0001 Version=0100
N: Name="PC Speaker"
P: Phys=isa0061/input0
S: Sysfs=/devices/platform/pcspkr/input/input6
U: Uniq=
H: Handlers=kbd event6
B: PROP=0
B: EV=40001
B: SND=6
"""

DESKTOP_USB_KEYBOARD = POWER_BUTTONS + "\n" + """\
I: Bus=0003 Vendor=046d Product=c31c Version=0110
N: Name="Logitech USB Keyboard"
P: Phys=usb-0000:00:14.0-1/input0
S: Sysfs=/devices/pci0000:00/0000:00:14.0/usb1/1-1/1-1:1.0/0003:046D:C31C.0001/input/input2
U: Uniq=
H: Handlers=sysrq kbd event2 leds
B: PROP=0
B: EV=120013
B: KEY=1000000000007 ff9f207ac14057ff febeffdfffefffff fffffffffffffffe
B: MSC=10
B: LED=7

I: Bus=0003 Vendor=046d Product=c31c Version=0110
N: Name="Logitech USB Keyboard Consumer Control"
P: Phys=usb-0000:00:14.0-1/input1
S: Sysfs=/devices/pci0000:00/0000:00:14.0/usb1/1-1/1-1:1.1/0003:046D:C31C.0002/input/input3
U: Uniq=
H: Handlers=kbd event3
B: PROP=0
B: EV=1f
B: KEY=300ff 0 0 0 0 483ffff17aff32d bfd4444600000000 1 130c730b17c000 267bfad9415fed 9e168000004400 10000002
B: REL=1040
B: ABS=100000000
B: MSC=10

I: Bus=0003 Vendor=046d Product=c077 Version=0111
N: Name="Logitech USB Optical Mouse"
P: Phys=usb-0000:00:14.0-2/input0
S: Sysfs=/devices/pci0000:00/0000:00:14.0/usb1/1-2/1-2:1.0/0003:046D:C077.0003/input/input5
U: Uniq=
H: Handlers=mouse0 event5
B: PROP=0
B: EV=17
B: KEY=ff0000 0 0 0 0
B: REL=903
B: MSC=10
""" + "\n" + PC_SPEAKER

LAPTOP = """\
I: Bus=0019 Vendor=0000 Product=0005 Version=0000
N: Name="Lid Switch"
P: Phys=PNP0C0D/button/input0
S: Sysfs=/devices/LNXSYSTM:00/LNXSYBUS:00/PNP0C0D:00/input/input0
U: Uniq=
H: Handlers=event0
B: PROP=0
B: EV=21
B: SW=1

I: Bus=0019 Vendor=0000 Product=0003 Version=0000
N: Name="Sleep Button"
P: Phys=PNP0C0E/button/input0
S: Sysfs=/devices/LNXSYSTM:00/LNXSYBUS:00/PNP0C0E:00/input/input1
U: Uniq=
H: Handlers=kbd event1
B: PROP=0
B: EV=3
B: KEY=4000 0 0

I: Bus=0011 Vendor=0001 Product=0001 Version=ab41
N: Name="AT Translated Set 2 keyboard"
P: Phys=isa0060/serio0/input0
S: Sysfs=/devices/platform/i8042/serio0/input/input3
U: Uniq=
H: Handlers=sysrq kbd event3 leds
B: PROP=0
B: EV=120013
B: KEY=402000000 3803078f800d001 feffffdfffefffff fffffffffffffffe
B: MSC=10
B: LED=7

I: Bus=0019 Vendor=0000 Product=5054 Version=4101
N: Name="ThinkPad Extra Buttons"
P: Phys=thinkpad_acpi/input0
S: Sysfs=/devices/platform/thinkpad_acpi/input/input7
U: Uniq=
H: Handlers=rfkill kbd event7
B: PROP=0
B: EV=33
B: KEY=10040 0 18040000 0 50000000000000 0 1701b02102004 c000280051115000 10e000000000000 0
B: MSC=10
B: SW=8

I: Bus=0011 Vendor=0002 Product=0007 Version=01b1
N: Name="SynPS/2 Synaptics TouchPad"
P: Phys=isa0060/serio1/input0
S: Sysfs=/devices/platform/i8042/serio1/input/input5
U: Uniq=
H: Handlers=mouse0 event5
B: PROP=5
B: EV=b
B: KEY=e520 10000 0 0 0 0
B: ABS=660800011000003
""" + "\n" + VIDEO_BUS

TOUCH_KIOSK = POWER_BUTTONS + "\n" + VIDEO_BUS + "\n" + """\
I: Bus=0003 Vendor=0eef Product=c000 Version=0111
N: Name="eGalax Inc. eGalaxTouch EXC3000-0368-46.00.00"
P: Phys=usb-0000:00:14.0-4/input0
S: Sysfs=/devices/pci0000:00/0000:00:14.0/usb1/1-4/1-4:1.0/0003:0EEF:C000.0001/input/input8
U: Uniq=
H: Handlers=mouse0 event8
B: PROP=2
B: EV=1b
B: KEY=400 0 0 0 0 0
B: ABS=260800000000003
B: MSC=10
"""

# An I2C tablet controller with a Home key: a "kbd" handler, one key, no letters.
TABLET = POWER_BUTTONS + "\n" + """\
I: Bus=0019 Vendor=0000 Product=0000 Version=0000
N: Name="Intel HID events"
P: Phys=
S: Sysfs=/devices/pci0000:00/INT33D5:00/input/input9
U: Uniq=
H: Handlers=rfkill kbd event9
B: PROP=0
B: EV=13
B: KEY=81000300000000 5000004000 1e294000000020 0
B: MSC=10

I: Bus=0018 Vendor=0416 Product=1001 Version=0100
N: Name="Goodix Capacitive TouchScreen"
P: Phys=input/ts
S: Sysfs=/devices/pci0000:00/0000:00:16.0/i2c_designware.0/i2c-1/i2c-GDIX1001:00/input/input10
U: Uniq=
H: Handlers=kbd event10
B: PROP=2
B: EV=b
B: KEY=400 0 0 0 2000000000000000 0
B: ABS=265800000000003
""" + "\n" + VIDEO_BUS

# What a uinput "keyboard" a program drives looks like: every key, no person.
UINPUT_KEYBOARD = """\
I: Bus=0006 Vendor=2333 Product=6666 Version=0001
N: Name="ydotoold virtual device"
P: Phys=
S: Sysfs=/devices/virtual/input/input20
U: Uniq=
H: Handlers=sysrq kbd mouse1 event20 leds
B: PROP=0
B: EV=120007
B: KEY=1f0000 0 0 0 0 7fffffffffffff ffffffffffffffff ffffffffffffffff fffffffffffffffe
B: REL=143
B: LED=1f
"""


class KeyboardDetection(unittest.TestCase):
    def test_a_desktop_with_a_usb_keyboard_has_one(self):
        self.assertEqual(
            agent.detect_input_devices(DESKTOP_USB_KEYBOARD, word_bits=64),
            {"keyboardPresent": True, "touchPresent": False},
        )

    def test_a_laptop_keyboard_counts_and_its_touchpad_is_not_a_touchscreen(self):
        self.assertEqual(
            agent.detect_input_devices(LAPTOP, word_bits=64),
            {"keyboardPresent": True, "touchPresent": False},
        )

    def test_a_touch_kiosk_with_only_buttons_has_no_keyboard(self):
        self.assertEqual(
            agent.detect_input_devices(TOUCH_KIOSK, word_bits=64),
            {"keyboardPresent": False, "touchPresent": True},
        )

    def test_a_tablet_whose_hotkeys_and_touchscreen_register_kbd_has_no_keyboard(self):
        self.assertEqual(
            agent.detect_input_devices(TABLET, word_bits=64),
            {"keyboardPresent": False, "touchPresent": True},
        )

    def test_buttons_speakers_and_hotkeys_are_never_keyboards(self):
        for device in agent.parse_input_devices(POWER_BUTTONS + "\n" + VIDEO_BUS + "\n" + PC_SPEAKER + "\n" + LAPTOP):
            if device["name"] == "AT Translated Set 2 keyboard":
                continue
            with self.subTest(device=device["name"]):
                self.assertFalse(agent.is_keyboard_device(device, word_bits=64))

    def test_a_program_driven_virtual_device_is_not_a_keyboard(self):
        self.assertEqual(
            agent.detect_input_devices(TOUCH_KIOSK + "\n" + UINPUT_KEYBOARD, word_bits=64)["keyboardPresent"],
            False,
        )

    def test_nothing_listed_means_unknown_not_absent(self):
        # The Docker simulator on a desktop VM (and this file inside most
        # virtual machines driven over VNC) lists no device at all: the bar
        # must not open a keyboard over someone typing through noVNC.
        for text in ("", "\n\n", "garbage without fields\n"):
            with self.subTest(text=text):
                self.assertEqual(
                    agent.detect_input_devices(text, word_bits=64),
                    {"keyboardPresent": None, "touchPresent": None},
                )

    def test_bitmaps_are_read_in_the_kernels_word_size(self):
        words64 = "402000000 3803078f800d001 feffffdfffefffff fffffffffffffffe".split()
        words32 = "4 2000000 3803078 f800d001 feffffdf ffefffff ffffffff fffffffe".split()
        for code in agent.KEYBOARD_REQUIRED_KEYS + (1, 116, 240):
            with self.subTest(code=code):
                self.assertEqual(
                    agent.input_bitmap_has(words64, code, 64),
                    agent.input_bitmap_has(words32, code, 32),
                )
        self.assertFalse(agent.input_bitmap_has(words64, 0, 64))
        self.assertFalse(agent.input_bitmap_has(words64, 4096, 64))
        self.assertFalse(agent.input_bitmap_has(["zz"], 1, 64))


class KeyboardReport(unittest.TestCase):
    def setUp(self):
        agent._input_devices.update(value=None, at=None, problem=None)
        LOGGED.clear()
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "devices")

    def write(self, text):
        with open(self.path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)

    def test_the_report_is_cached_briefly_and_then_reread(self):
        self.write(TOUCH_KIOSK)
        self.assertFalse(agent.input_devices_report(now=100.0, path=self.path)["keyboardPresent"])
        self.write(TOUCH_KIOSK + "\n" + DESKTOP_USB_KEYBOARD)  # a keyboard is plugged in
        self.assertFalse(agent.input_devices_report(now=101.0, path=self.path)["keyboardPresent"])
        later = 100.0 + agent.INPUT_DEVICES_TTL_SECONDS
        self.assertTrue(agent.input_devices_report(now=later, path=self.path)["keyboardPresent"])

    def test_an_unreadable_file_is_unknown_and_logged_once(self):
        missing = os.path.join(self.dir.name, "absent")
        for now in (0.0, 10.0, 20.0):
            self.assertEqual(
                agent.input_devices_report(now=now, path=missing),
                {"keyboardPresent": None, "touchPresent": None},
            )
        self.assertEqual(len(LOGGED), 1)
        self.assertIn("Keyboard presence unknown", LOGGED[0])

    def test_the_status_endpoint_and_the_bar_carry_it(self):
        with open(os.path.join(CHROOT, "opt/labkiosk/agent/agent.py"), encoding="utf-8") as handle:
            source = handle.read()
        self.assertIn('"keyboardPresent": inputs["keyboardPresent"]', source)
        self.assertIn('"touchPresent": inputs["touchPresent"]', source)
        with open(os.path.join(CHROOT, "opt/labkiosk/extension/content.js"), encoding="utf-8") as handle:
            content = handle.read()
        self.assertIn("keyboardPresent === false", content)
        self.assertIn('id="btn-keyboard"', content)
        with open(os.path.join(CHROOT, "etc/apparmor.d/labkiosk-agent"), encoding="utf-8") as handle:
            self.assertRegex(handle.read(), re.compile(r"^\s*@\{PROC\}/bus/input/devices r,$", re.M))


if __name__ == "__main__":
    unittest.main(verbosity=2)
