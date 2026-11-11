"""Package only the portable inputs, without recording host or archive metadata."""
import gzip
import io
import json
from pathlib import Path
import re
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
    "profiler/history.mjs", "profiler/history-model.mjs", "profiler/history-reports.mjs", "profiler/tests/history.test.mjs",
    "history/releases.json",
    "docs/report-overview.jpg", "docs/report-distributions.jpg",
    "docs/report-allocations.jpg", "docs/version-comparison.jpg",
)

# Only named report artifacts for the versions in the public synthetic history.
FILES += ("reports/memory/README.md",)
for series in json.loads((ROOT / "history/releases.json").read_text())["series"]:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", series["id"]):
        raise ValueError("Invalid report series")
    for release in series["releases"]:
        if not re.fullmatch(r"\d+\.\d+\.\d+", release["version"]):
            raise ValueError("Invalid report version")
        prefix = "reports/memory/" + series["id"] + "/" + release["version"] + "/"
        FILES += tuple(prefix + name for name in (
            "comparison.json", "report.html", "report.md", "report.csv", "report.json", "timeline.svg",
        ))

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
