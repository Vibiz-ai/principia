# dmgbuild settings for the release dmg's window (scripts/dmg-layout/make-template.sh). Everything comes from
# build/dmg/layout.json, the one place the layout is written down (make-icons.swift draws the background to it and
# scripts/mac-sign.test.mjs checks the committed .DS_Store against it).
import json
import os

layout = json.load(open(defines["layout"]))  # noqa: F821 (dmgbuild provides `defines`)
win = layout["window"]

volume_name = layout["volumeName"]
format = "UDRW"
filesystem = "HFS+"
size = "8M"
# a stand-in for the app: the window only records names and positions
files = [defines["app"]]  # noqa: F821
symlinks = {"Applications": "/Applications"}
background = defines["background"]  # noqa: F821 (copied to /.background.tiff)
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
sidebar_width = 0
# Finder's window bounds: x, y from the bottom-left of the screen, and the size including the title bar, so the
# content area is exactly the background picture
window_rect = ((win["x"], win["y"]), (win["width"], win["height"] + win["titleBar"]))
default_view = "icon-view"
show_icon_preview = False
include_icon_view_settings = True
include_list_view_settings = False
arrange_by = None
label_pos = "bottom"
text_size = layout["textSize"]
icon_size = layout["iconSize"]
icon_locations = {name: (p["x"], p["y"]) for name, p in layout["icons"].items()}
