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
    "profiler/Dockerfile", "profiler/run.mjs", "profiler/worker.mjs",
    "profiler/collect.mjs", "profiler/heap.py", "profiler/model.mjs",
    "profiler/report.mjs", "profiler/native/allocator.rs",
    "profiler/native/build.py", "profiler/native/analyze.py", "profiler/native/source.py",
    "profiler/tests/report.test.mjs", "profiler/tests/heap.test.mjs",
    "profiler/tests/native.test.mjs",
    "profiler/tests/archive.test.mjs",
    "profiler/bootstrap.py", "profiler/environment.mjs", "profiler/releases.Dockerfile",
    "profiler/versions.mjs", "profiler/versions-model.mjs", "profiler/versions-report.mjs",
    "profiler/tests/versions.test.mjs",
    "docs/report-overview.jpg", "docs/report-distributions.jpg",
    "docs/report-allocations.jpg", "docs/version-comparison.jpg",
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
