from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

PROJECT_NAME = "TemplateWorkspace"
ROOT_DIR = Path(__file__).resolve().parents[1]
WINDOWS_LINUX_SPEC = ROOT_DIR / "TemplateWorkspace.spec"
MACOS_SPEC = ROOT_DIR / "TemplateWorkspace.macos.spec"
DEFAULT_OUTPUT_DIR = ROOT_DIR / "release-artifacts"
PYINSTALLER_BUILD_ROOT = Path(tempfile.gettempdir()) / "TemplateWorkspace-release"
SKIP_BUILD_ENV = "TW_SKIP_BUILD"


def normalize_version(raw: str | None) -> str:
    value = (raw or "snapshot").strip()
    if value.startswith("v") and len(value) > 1:
        value = value[1:]
    return value or "snapshot"


def detect_platform() -> tuple[str, str]:
    if sys.platform.startswith("win"):
        os_name = "Windows"
    elif sys.platform == "darwin":
        os_name = "macOS"
    elif sys.platform.startswith("linux"):
        os_name = "Linux"
    else:
        raise RuntimeError(f"unsupported platform: {sys.platform}")

    machine = platform.machine().lower()
    arch_map = {
        "amd64": "x86_64",
        "x86_64": "x86_64",
        "x64": "x86_64",
        "arm64": "arm64",
        "aarch64": "arm64",
    }
    arch_name = arch_map.get(machine)
    if not arch_name:
        raise RuntimeError(f"unsupported architecture: {machine}")
    return os_name, arch_name


def stage_paths(os_name: str, arch_name: str) -> tuple[Path, Path]:
    safe_os = os_name.lower().replace("os", "os-")
    stage_root = PYINSTALLER_BUILD_ROOT / f"{safe_os}-{arch_name}"
    return stage_root / "work", stage_root / "dist"


def clean_output_dir(output_dir: Path) -> None:
    if output_dir.exists():
        for path in sorted(output_dir.rglob("*"), reverse=True):
            try:
                if path.is_file() or path.is_symlink():
                    path.unlink()
                elif path.is_dir():
                    path.rmdir()
            except OSError:
                pass
        try:
            output_dir.rmdir()
        except OSError:
            pass
    output_dir.mkdir(parents=True, exist_ok=True)


def build_with_pyinstaller(work_dir: Path, dist_dir: Path) -> Path:
    if sys.platform == "darwin":
        spec_path = MACOS_SPEC
    else:
        spec_path = WINDOWS_LINUX_SPEC

    if not spec_path.exists():
        raise FileNotFoundError(f"missing PyInstaller spec: {spec_path}")

    if work_dir.exists():
        shutil.rmtree(work_dir)
    if dist_dir.exists():
        shutil.rmtree(dist_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    dist_dir.mkdir(parents=True, exist_ok=True)

    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--workpath",
        str(work_dir),
        "--distpath",
        str(dist_dir),
        str(spec_path),
    ]
    env = os.environ.copy()
    env["PYINSTALLER_CONFIG_DIR"] = str(PYINSTALLER_BUILD_ROOT / "cache")
    subprocess.run(command, check=True, cwd=ROOT_DIR, env=env)

    bundle_name = f"{PROJECT_NAME}.app" if sys.platform == "darwin" else PROJECT_NAME
    app_path = dist_dir / bundle_name
    if not app_path.exists():
        raise FileNotFoundError(f"expected packaged app at {app_path}")
    return app_path


def iter_paths_for_zip(root_path: Path) -> list[tuple[Path, str]]:
    root_name = root_path.name
    items: list[tuple[Path, str]] = [(root_path, f"{root_name}/")]
    for path in sorted(root_path.rglob("*")):
        relative = path.relative_to(root_path).as_posix()
        arcname = f"{root_name}/{relative}"
        if path.is_dir():
            arcname = f"{arcname}/"
        items.append((path, arcname))
    return items


def add_path_to_zip(zip_file: zipfile.ZipFile, path: Path, arcname: str) -> None:
    info = zipfile.ZipInfo(arcname)
    info.create_system = 3
    mode = path.stat().st_mode
    info.external_attr = (mode & 0xFFFF) << 16

    if path.is_dir():
        info.external_attr |= 0x10
        zip_file.writestr(info, b"")
        return

    compression = zipfile.ZIP_DEFLATED
    with path.open("rb") as handle:
        data = handle.read()
    zip_file.writestr(info, data, compress_type=compression)


def zip_packaged_app(source_path: Path, archive_path: Path) -> None:
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    if archive_path.exists():
        archive_path.unlink()

    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as zip_file:
        for path, arcname in iter_paths_for_zip(source_path):
            add_path_to_zip(zip_file, path, arcname)


def build_archive_name(version: str, os_name: str, arch_name: str) -> str:
    return f"{PROJECT_NAME}_{version}_{os_name}_{arch_name}.zip"


def should_skip_build() -> bool:
    return os.environ.get(SKIP_BUILD_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


def command_build_current(args: argparse.Namespace) -> int:
    version = normalize_version(args.version)
    output_dir = Path(args.output).resolve()
    os_name, arch_name = detect_platform()

    if args.clean:
        clean_output_dir(output_dir)
    else:
        output_dir.mkdir(parents=True, exist_ok=True)

    if should_skip_build():
        print(f"Skipping package build because {SKIP_BUILD_ENV} is enabled.")
        return 0

    work_dir, dist_dir = stage_paths(os_name, arch_name)
    app_path = build_with_pyinstaller(work_dir, dist_dir)
    archive_path = output_dir / build_archive_name(version, os_name, arch_name)
    zip_packaged_app(app_path, archive_path)
    print(f"Created archive: {archive_path}")
    return 0


def sha256_for(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def command_write_checksums(args: argparse.Namespace) -> int:
    version = normalize_version(args.version)
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    archives = sorted(output_dir.glob(f"{PROJECT_NAME}_{version}_*.zip"))
    if not archives:
        archives = sorted(output_dir.glob(f"{PROJECT_NAME}_*.zip"))
    if not archives:
        raise FileNotFoundError(f"no archives found in {output_dir} for version {version}")

    checksum_path = output_dir / f"{PROJECT_NAME}_{version}_checksums.txt"
    with checksum_path.open("w", encoding="utf-8", newline="\n") as handle:
        for archive in archives:
            handle.write(f"{sha256_for(archive)}  {archive.name}\n")
    print(f"Wrote checksums: {checksum_path}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Package desktop release artifacts.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    build_current = subparsers.add_parser("build-current", help="Build the current platform artifact.")
    build_current.add_argument("--version", default="snapshot")
    build_current.add_argument("--output", default=str(DEFAULT_OUTPUT_DIR))
    build_current.add_argument("--clean", action="store_true")
    build_current.set_defaults(func=command_build_current)

    write_checksums = subparsers.add_parser("write-checksums", help="Write a checksum file for built archives.")
    write_checksums.add_argument("--version", default="snapshot")
    write_checksums.add_argument("--output", default=str(DEFAULT_OUTPUT_DIR))
    write_checksums.set_defaults(func=command_write_checksums)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
