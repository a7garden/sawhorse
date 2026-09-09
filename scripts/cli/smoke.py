#!/usr/bin/env python3
"""Exercise packaged installers using the real CLI, in an isolated directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile
import zipfile
from package import package


def main(binary: Path) -> None:
    binary = binary.resolve()
    windows = os.name == "nt"
    target = "x86_64-pc-windows-msvc" if windows else (("aarch64" if platform.machine() == "arm64" else "x86_64") + "-apple-darwin" if platform.system() == "Darwin" else "x86_64-unknown-linux-gnu")
    with tempfile.TemporaryDirectory(prefix="sawhorse package 한글 ") as directory:
        root = Path(directory)
        archive = package(binary, target, "test", root / "archives")
        expected = archive.with_name(archive.name + ".sha256").read_text().split()[0]
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected
        extracted = root / "압축 해제"
        extracted.mkdir()
        if windows:
            with zipfile.ZipFile(archive) as reader:
                reader.extractall(extracted)
        else:
            with tarfile.open(archive) as reader:
                try:
                    reader.extractall(extracted, filter="data")
                except TypeError:  # extraction filters arrived in Python 3.12; older runtimes extract as-is
                    reader.extractall(extracted)
        bundle = next(extracted.iterdir())
        destination = root / "설치 bin"
        if windows:
            subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(bundle / "install.ps1"), "-BinDirectory", str(destination), "-NoPathUpdate"], check=True)
        else:
            subprocess.run(["sh", str(bundle / "install.sh"), str(destination)], check=True)
        installed = destination / ("sawhorse.exe" if windows else "sawhorse")
        response = subprocess.run([str(installed), "workflow", "schema", "--json"], check=True, capture_output=True)
        assert json.loads(response.stdout)["data"]["properties"]["nodes"]
        response = subprocess.run([str(installed), "skill", "install", "--dir", str(root / "스킬"), "--json"], check=True, capture_output=True)
        skill = Path(json.loads(response.stdout)["data"]["path"])
        assert skill.read_bytes() == (bundle / "sawhorse-workflow-author/SKILL.md").read_bytes()
        # Installation is repeatable and does not depend on the extraction path.
        if windows:
            subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(bundle / "install.ps1"), "-BinDirectory", str(destination), "-NoPathUpdate"], check=True)
        else:
            subprocess.run(["sh", str(bundle / "install.sh"), str(destination)], check=True)
        print("ok: archive, checksum, native installer, console execution, bundled skill")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    main(parser.parse_args().binary)
