import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('portable source extraction accepts internal links and rejects escaping paths', () => {
  const result = spawnSync('python3', ['-c', `
from profiler.native.source import unpack
from pathlib import Path
import io,tarfile,tempfile
with tempfile.TemporaryDirectory(prefix='source-archive-') as root:
    root=Path(root)
    def make(file,name,link=None):
        with tarfile.open(file,'w') as tar:
            item=tarfile.TarInfo(name)
            if link:
                item.type=tarfile.SYMTYPE;item.linkname=link;tar.addfile(item)
            else:
                item.size=2;tar.addfile(item,io.BytesIO(b'ok'))
    make(root/'good.tar','source/a')
    unpack(root/'good.tar',root/'good','source')
    assert (root/'good/source/a').read_text()=='ok'
    make(root/'link.tar','source/sub/link','../a')
    unpack(root/'link.tar',root/'link','source')
    assert (root/'link/source/sub/link').is_symlink()
    for i,(name,link) in enumerate([('../escape',None),('source/link','../../escape'),('/tmp/escape',None)]):
        make(root/'bad.tar',name,link)
        try: unpack(root/'bad.tar',root/str(i),'source')
        except ValueError: pass
        else: raise AssertionError('Escaping member accepted')
    assert not (root/'escape').exists()
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
