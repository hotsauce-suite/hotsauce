# dmgbuild settings for the disk image window (https://github.com/dmgbuild/dmgbuild, MIT).
# build-app.sh passes -D app=<path to .app> -D background=<background.tiff>. The window and
# positions match Resources/dmg/background.html: 660 x 400, the app at (180, 190), Applications at
# (480, 190), 128 px icons.
import os.path

app = defines["app"]
app_name = os.path.basename(app)

format = "UDZO"
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}

background = defines["background"]
window_rect = ((200, 160), (660, 400))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False

icon_size = 128
text_size = 13
arrange_by = None
label_pos = "bottom"
icon_locations = {
    app_name: (180, 190),
    "Applications": (480, 190),
}
