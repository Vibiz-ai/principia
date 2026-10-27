# Rewrites the background's alias and bookmark in a dmgbuild .DS_Store to name /Volumes/<volume name>, the place a
# downloaded dmg mounts. dmgbuild records wherever its scratch image happened to mount ("/Volumes/Principia 1" when a
# Principia dmg is already open). Finder finds the background through the volume name and the path in the volume; the
# volume UUID and file id in the bookmark never match a new dmg anyway, so they are left as they are.
# Usage: python normalize.py <.DS_Store> <volume name>
import sys

from ds_store import DSStore
from mac_alias import URL, Alias

path, volname = sys.argv[1], sys.argv[2]
mount = "/Volumes/" + volname
with DSStore.open(path, "r+") as d:
    icvp = d["."]["icvp"]
    alias = Alias.from_bytes(icvp["backgroundImageAlias"])
    alias.volume.name = volname
    alias.volume.posix_path = mount
    alias.target.folder_name = volname
    icvp["backgroundImageAlias"] = alias.to_bytes()
    d["."]["icvp"] = icvp
    bookmark = d["."]["pBBk"]
    for _, toc in bookmark.tocs:
        toc[0x2002] = mount
        toc[0x2005] = URL(None, "file://" + mount + "/")
        toc[0x2010] = volname
    d["."]["pBBk"] = bookmark
print("background alias and bookmark point at " + mount)
