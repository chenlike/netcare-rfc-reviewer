"""Windows ZIP packaging, streaming files instead of buffering the full runtime."""
from pathlib import Path
import sys
from zipfile import ZipFile, ZIP_DEFLATED

source, destination = map(lambda x: Path(x).resolve(), sys.argv[1:])
assert source.is_dir() and destination.parent == source.parent
with ZipFile(destination, "w", ZIP_DEFLATED, compresslevel=6) as archive:
    for file in sorted(source.rglob("*")):
        if file.is_file():
            archive.write(file, file.relative_to(source.parent).as_posix())
