"""Fetch fixed public codec sources into ignored tooling; no SDK installation."""
import concurrent.futures
import io
import json
import pathlib
import sys
import urllib.request
import zipfile

SOURCES = json.loads(pathlib.Path(__file__).with_name("sources.json").read_text())

def fetch(item, work):
    name, repository, revision = item["name"], item["repository"], item["revision"]
    url = item["url"]
    archive = work / "archives" / f"{name}-{revision}.zip"
    if not archive.exists():
        archive.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(url, headers={"User-Agent": "OpenLR-codec-build"})
        data = urllib.request.urlopen(request, timeout=180).read()
        archive.write_bytes(data)
    data = archive.read_bytes()
    target = work / "source" / "libjxl"
    if name != "libjxl":
        target = target / "third_party" / name
    target.mkdir(parents=True, exist_ok=True)
    marker = target / ".openlr-source-revision"
    if not marker.exists() or marker.read_text() != revision:
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            for member in package.infolist():
                relative = pathlib.PurePosixPath(member.filename)
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("Unsafe source archive entry")
                relative = pathlib.Path(*relative.parts[1:])
                if not relative.parts or member.is_dir():
                    continue
                output = target / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(package.read(member))
        marker.write_text(revision)
    return {"name": name, "repository": repository, "revision": revision,
            "url": url, "bytes": len(data)}

def main():
    work = pathlib.Path(sys.argv[1]).resolve()
    # Complete libjxl extraction before placing submodules in its empty folders.
    records = [fetch(next(item for item in SOURCES if item["name"] == "libjxl"), work)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        dependencies = [item for item in SOURCES if item["name"] != "libjxl"]
        records.extend(pool.map(lambda item: fetch(item, work), dependencies))
    (work / "sources.json").write_text(json.dumps(records, indent=2) + "\n")
    print(json.dumps(records, indent=2))

if __name__ == "__main__":
    main()
