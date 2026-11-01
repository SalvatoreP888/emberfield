#!/usr/bin/env python3
"""Package the portable source and ready-to-serve app without build caches."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist" / "emberfield-source.zip"
SKIP = {".git", ".openai", "node_modules", "target", "__pycache__"}


def package() -> None:
    files = sorted(
        p for p in ROOT.rglob("*")
        if p.is_file()
        and not p.is_symlink()
        and p != OUTPUT
        and not SKIP.intersection(p.relative_to(ROOT).parts)
        and not p.name.endswith((".tar.gz", ".pyc"))
    )
    with ZipFile(OUTPUT, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            archive.write(path, Path("emberfield") / path.relative_to(ROOT))
    with ZipFile(OUTPUT) as archive:
        invalid = archive.testzip()
        if invalid:
            raise RuntimeError(f"Archive checksum failed: {invalid}")
    print(f"Packaged {len(files)} files into {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    package()
