"""Extract a public source archive into an empty directory, including on Python 3.9."""
import os
from pathlib import Path, PurePosixPath
import posixpath
import tarfile


def unpack(archive, destination, prefix):
    root = Path(destination).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if any(root.iterdir()):
        raise ValueError('Source extraction requires an empty directory')

    def inside(name):
        path = PurePosixPath(name)
        return not path.is_absolute() and (name == prefix or name.startswith(prefix + '/')) and '..' not in path.parts

    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        for member in members:
            if not inside(member.name) or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError('Unsupported source archive member')
            if member.issym() or member.islnk():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname)
                                           if member.issym() else member.linkname)
                if not inside(target):
                    raise ValueError('Source link leaves the checkout')
        for member in members:
            if not (root / member.name).resolve().is_relative_to(root):
                raise ValueError('Source path leaves the extraction directory')
            member.mode &= 0o777
            member.uid, member.gid, member.uname, member.gname = os.getuid(), os.getgid(), '', ''
            tar.extract(member, root)
