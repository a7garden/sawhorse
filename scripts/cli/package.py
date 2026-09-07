#!/usr/bin/env python3
"""Package a prebuilt native CLI; Python is only used by development/CI."""
import argparse
import hashlib
from pathlib import Path
import shutil
import tarfile
import tempfile
import zipfile


def package(binary: Path, target: str, version: str, output: Path) -> Path:
    repo = Path(__file__).resolve().parents[2]
    output.mkdir(parents=True, exist_ok=True)
    name = f"sawhorse-cli-{version}-{target}"
    windows = "windows" in target
    archive = output / (name + (".zip" if windows else ".tar.gz"))
    with tempfile.TemporaryDirectory() as temporary:
        staging = Path(temporary) / name
        staging.mkdir()
        executable = staging / ("sawhorse.exe" if windows else "sawhorse")
        shutil.copy2(binary, executable)
        executable.chmod(0o755)
        for filename in ("install.ps1", "install.sh"):
            shutil.copy2(repo / "scripts/cli" / filename, staging / filename)
        (staging / "install.sh").chmod(0o755)
        shutil.copy2(repo / "docs/cli.md", staging / "README.md")
        shutil.copytree(repo / "plugin/skills/sawhorse-workflow-author", staging / "sawhorse-workflow-author")
        if (repo / "LICENSE").is_file():
            shutil.copy2(repo / "LICENSE", staging / "LICENSE")
        if windows:
            with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as writer:
                for path in sorted(staging.rglob("*")):
                    if path.is_file():
                        writer.write(path, path.relative_to(staging.parent))
        else:
            with tarfile.open(archive, "w:gz") as writer:
                writer.add(staging, arcname=name)
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_name(archive.name + ".sha256").write_text(f"{checksum}  {archive.name}\n", encoding="utf-8")
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--target", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(package(args.binary, args.target, args.version, args.output))
