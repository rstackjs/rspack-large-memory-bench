"""Package only the portable inputs, without recording host or archive metadata."""
import gzip
import io
from pathlib import Path
import sys
import tarfile

ROOT = Path(__file__).resolve().parent
FILES = (
    ".gitignore", "README.md", "baseline.json", "bench.mjs", "compare.mjs",
    "config.mjs", "generate.mjs", "inspect.mjs", "mapped-input.cjs", "pack.py",
    "package-lock.json", "package.json", "plugins.mjs",
)

if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 pack.py OUTPUT.tar.gz")
    with Path(sys.argv[1]).open("wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as tar:
                for name in FILES:
                    data = (ROOT / name).read_bytes()
                    item = tarfile.TarInfo("large-memory/" + name)
                    item.size = len(data)
                    item.mode = 0o644
                    tar.addfile(item, io.BytesIO(data))
