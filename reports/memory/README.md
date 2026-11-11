# Historical release memory reports

Each directory contains a standalone HTML report, a GitHub-readable Markdown report, CSV, JSON and an SVG curve. Download and open `report.html` for the server/client selector. These reports use three full release builds per version, with server and client measured serially. They show RSS and V8 counters, not Rust allocation snapshots or JS object-size tables. No builds are run when exporting.

The JSON retains every round, input hashes and binding versions. Independent environments have separate directories. The original raw collection is not required to open the exported reports.

## local-linux-arm64

| Version | Read on GitHub | Open locally | Data |
| --- | --- | --- | --- |
| 2.2.6 | [Markdown](local-linux-arm64/2.2.6/report.md) | [HTML](local-linux-arm64/2.2.6/report.html) | [JSON](local-linux-arm64/2.2.6/report.json) · [CSV](local-linux-arm64/2.2.6/report.csv) |
| 2.2.7 | [Markdown](local-linux-arm64/2.2.7/report.md) | [HTML](local-linux-arm64/2.2.7/report.html) | [JSON](local-linux-arm64/2.2.7/report.json) · [CSV](local-linux-arm64/2.2.7/report.csv) |
| 2.2.8 | [Markdown](local-linux-arm64/2.2.8/report.md) | [HTML](local-linux-arm64/2.2.8/report.html) | [JSON](local-linux-arm64/2.2.8/report.json) · [CSV](local-linux-arm64/2.2.8/report.csv) |
| 2.2.9 | [Markdown](local-linux-arm64/2.2.9/report.md) | [HTML](local-linux-arm64/2.2.9/report.html) | [JSON](local-linux-arm64/2.2.9/report.json) · [CSV](local-linux-arm64/2.2.9/report.csv) |
| 2.3.0 | [Markdown](local-linux-arm64/2.3.0/report.md) | [HTML](local-linux-arm64/2.3.0/report.html) | [JSON](local-linux-arm64/2.3.0/report.json) · [CSV](local-linux-arm64/2.3.0/report.csv) |
| 2.3.1 | [Markdown](local-linux-arm64/2.3.1/report.md) | [HTML](local-linux-arm64/2.3.1/report.html) | [JSON](local-linux-arm64/2.3.1/report.json) · [CSV](local-linux-arm64/2.3.1/report.csv) |
| 2.3.2 | [Markdown](local-linux-arm64/2.3.2/report.md) | [HTML](local-linux-arm64/2.3.2/report.html) | [JSON](local-linux-arm64/2.3.2/report.json) · [CSV](local-linux-arm64/2.3.2/report.csv) |
