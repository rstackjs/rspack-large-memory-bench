"""Copy only portable inputs. Generate/build on the container's local filesystem."""
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys

source = Path(__file__).resolve().parents[1]
inputs = runpy.run_path(str(source / 'pack.py'))['FILES']
for name in inputs:
    target = Path('/case') / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / name, target)
os.chdir('/case')
arguments = (['profiler/versions.mjs', *sys.argv[2:]] if sys.argv[1] == 'compare'
             else ['profiler/run.mjs', sys.argv[1]])
child = subprocess.Popen(['node', *arguments, '--inside'])
try:
    status = child.wait()
except BaseException:
    child.terminate()
    child.wait()
    raise
finally:
    # V8 snapshots are mode 0600. Return ownership of mounted artifacts to the
    # invoking host user, so DevTools and profile:report also work on Linux hosts.
    uid, gid = os.environ.get('PROFILE_UID', ''), os.environ.get('PROFILE_GID', '')
    if os.geteuid() == 0 and uid.isdecimal() and gid.isdecimal():
        for mounted in ['/case/results', '/case/.profile-cache']:
            for directory, dirs, files in os.walk(mounted, followlinks=False):
                for name in ['', *dirs, *files]:
                    item = Path(directory) / name
                    stat = item.lstat()
                    if (stat.st_uid, stat.st_gid) != (int(uid), int(gid)):
                        os.chown(item, int(uid), int(gid), follow_symlinks=False)
sys.exit(status)
