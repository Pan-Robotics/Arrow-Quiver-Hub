#!/usr/bin/env python3
"""Shared, literal-only configuration support for companion services.

This module deliberately implements a small EnvironmentFile-compatible parser instead
of executing a shell or importing a dotenv package.  Values are never interpolated.
"""

import argparse
import ipaddress
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple


_SCRIPT_DIR = Path(__file__).resolve().parent
_TEMPLATE_NAME = "companion-config.example"
_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_ALIAS_KEYS = ("HUB_URL", "WEB_SERVER_URL")
_MANAGED_ENVIRONMENT: Dict[str, str] = {}
_INITIAL_PROCESS_ENV: Dict[str, str] = dict(os.environ)
_LAST_EXPLICIT: Set[str] = set()


def _decode_value(value: str) -> str:
    """Decode the limited quote/escape syntax written by this module.

    The syntax is intentionally literal.  In particular, ``$VAR``, command
    substitution, and dotenv-style interpolation remain ordinary characters.
    """
    value = value.strip()
    if not value:
        return ""
    if value[0] == "'":
        closing = value.find("'", 1)
        if closing >= 0:
            return value[1:closing]
        return value[1:]
    if value[0] != '"':
        return value

    result: List[str] = []
    escaped = False
    for character in value[1:]:
        if escaped:
            # EnvironmentFile supports escaped quote/backslash.  Preserve an
            # unknown escape literally rather than interpreting it as a shell.
            if character in ('"', "\\"):
                result.append(character)
            else:
                result.append("\\" + character)
            escaped = False
        elif character == "\\":
            escaped = True
        elif character == '"':
            break
        else:
            result.append(character)
    if escaped:
        result.append("\\")
    return "".join(result)


def _parse_assignment(line: str) -> Optional[Tuple[str, str]]:
    """Return a key/value pair for one EnvironmentFile assignment, if present."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if "=" not in stripped:
        return None
    key, value = stripped.split("=", 1)
    key = key.strip()
    if not _KEY_RE.match(key):
        return None
    return key, _decode_value(value)


def parse_environment_file(path: Path) -> Dict[str, str]:
    """Read literal EnvironmentFile assignments from *path* if it exists."""
    values: Dict[str, str] = {}
    try:
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return values
    for line in content.splitlines():
        assignment = _parse_assignment(line)
        if assignment:
            key, value = assignment
            values[key] = value
    return values


def _format_value(value: str) -> str:
    """Format a literal value accepted by systemd EnvironmentFile.

    Always writing double-quoted values means paths, whitespace, shell-looking
    strings, and ``#`` remain data.  Newlines are rejected because an
    EnvironmentFile assignment must occupy one physical line.
    """
    if "\n" in value or "\r" in value:
        raise ValueError("EnvironmentFile values may not contain newlines")
    return '"{}"'.format(value.replace("\\", "\\\\").replace('"', '\\"'))


def _write_atomic(path: Path, content: str) -> None:
    """Replace *path* atomically with owner-readable configuration (0600)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".companion-config-", dir=str(path.parent))
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(str(temporary_path), str(path))
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except Exception:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass
        raise


def _read_lines(path: Path) -> List[str]:
    try:
        return path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []


def _default_example_for(env_file: Path) -> Path:
    """Prefer a colocated distributable template, then this helper's copy."""
    colocated = env_file.parent / _TEMPLATE_NAME
    if colocated.exists():
        return colocated
    return _SCRIPT_DIR / _TEMPLATE_NAME


def _render_lines(lines: Iterable[str]) -> str:
    rendered = "\n".join(lines)
    return rendered + ("\n" if rendered else "")


def _line_key(line: str) -> Optional[str]:
    assignment = _parse_assignment(line)
    return assignment[0] if assignment else None


def _replace_or_append(lines: List[str], key: str, value: str) -> None:
    """Replace every assignment for key while retaining comments and unknown rows."""
    replacement = f"{key}={_format_value(value)}"
    found = False
    for index, line in enumerate(lines):
        if _line_key(line) == key:
            lines[index] = replacement
            found = True
    if not found:
        lines.append(replacement)


def _synchronize_aliases(lines: List[str], values: Mapping[str, str]) -> None:
    """Migrate a one-name Hub URL configuration without replacing known values."""
    hub = values.get("HUB_URL")
    web = values.get("WEB_SERVER_URL")
    if hub is not None and web is None:
        _replace_or_append(lines, "WEB_SERVER_URL", hub)
    elif web is not None and hub is None:
        _replace_or_append(lines, "HUB_URL", web)


def initialize_environment(env_file: Path) -> None:
    """Add missing documented defaults without changing existing assignments."""
    example_file = _default_example_for(env_file)
    example_lines = _read_lines(example_file)
    if not example_lines:
        raise FileNotFoundError(
            f"No {_TEMPLATE_NAME} found next to {env_file} or {_SCRIPT_DIR}"
        )

    lines = _read_lines(env_file)
    if not lines and not env_file.exists():
        # A complete copy preserves the documentation and ordering for a new file.
        _write_atomic(env_file, _render_lines(example_lines))
        return

    existing = parse_environment_file(env_file)
    # Migrate a legacy one-alias file before example defaults can introduce a
    # blank counterpart and accidentally win the canonical tie-breaker.
    if "HUB_URL" not in existing and "WEB_SERVER_URL" in existing:
        _replace_or_append(lines, "HUB_URL", existing["WEB_SERVER_URL"])
        existing["HUB_URL"] = existing["WEB_SERVER_URL"]
    elif "WEB_SERVER_URL" not in existing and "HUB_URL" in existing:
        _replace_or_append(lines, "WEB_SERVER_URL", existing["HUB_URL"])
        existing["WEB_SERVER_URL"] = existing["HUB_URL"]
    for line in example_lines:
        key = _line_key(line)
        if key and key not in existing:
            lines.append(line)
            parsed = _parse_assignment(line)
            if parsed:
                existing[parsed[0]] = parsed[1]
    _synchronize_aliases(lines, existing)
    _write_atomic(env_file, _render_lines(lines))


def set_environment_values(env_file: Path, pairs: Sequence[Tuple[str, str]]) -> None:
    """Set literal values, synchronizing Hub URL aliases when either is explicit."""
    if not pairs:
        return
    lines = _read_lines(env_file)
    for key, value in pairs:
        if not _KEY_RE.match(key):
            raise ValueError(f"Invalid environment key: {key}")
        _replace_or_append(lines, key, value)
        if key in _ALIAS_KEYS:
            other = "WEB_SERVER_URL" if key == "HUB_URL" else "HUB_URL"
            _replace_or_append(lines, other, value)
    _write_atomic(env_file, _render_lines(lines))


def _bool_text(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _process_environment() -> Dict[str, str]:
    """Return process variables while retaining the service-manager baseline.

    More than one companion module may call :func:`load_environment` in the
    same interpreter.  The original systemd/process values must remain higher
    priority on every call, while values injected by a previous helper call do
    not become accidental user overrides.
    """
    values: Dict[str, str] = dict(_INITIAL_PROCESS_ENV)
    for key, value in os.environ.items():
        if _MANAGED_ENVIRONMENT.get(key) == value:
            continue
        values[key] = value
    return values


def _overlay(target: Dict[str, str], source: Mapping[str, str], level: int,
             sources: Dict[str, int], explicit: Set[str]) -> None:
    for key, value in source.items():
        target[key] = value
        sources[key] = level
        explicit.add(key)


def _normalize_hub_aliases(values: Dict[str, str], sources: Mapping[str, int]) -> None:
    """Resolve aliases by source priority, allowing a process alias to win.

    When both aliases come from the same source and differ, HUB_URL is the
    canonical tie-breaker.  ``set`` and ``init`` prevent that ambiguous state
    for subsequently maintained files.
    """
    candidates = []
    for index, key in enumerate(_ALIAS_KEYS):
        if key in values:
            candidates.append((sources.get(key, -1), -index, key, values[key]))
    if not candidates:
        return
    _, _, _, selected = max(candidates)
    values["HUB_URL"] = selected
    values["WEB_SERVER_URL"] = selected


def _expand_network_suffixes(values: Dict[str, str]) -> None:
    """Expand documented ``.NN`` host suffixes using NETWORK_SUBNET's IPv4 base."""
    subnet = values.get("NETWORK_SUBNET", "")
    try:
        network = ipaddress.ip_network(subnet, strict=False)
    except ValueError:
        return
    if network.version != 4:
        return
    prefix = str(network.network_address).rsplit(".", 1)[0]
    for key, value in list(values.items()):
        if key.endswith("_IP") and value.startswith("."):
            try:
                candidate = ipaddress.IPv4Address(prefix + value)
            except ipaddress.AddressValueError:
                continue
            if candidate in network:
                values[key] = str(candidate)


def _derive_values(values: Dict[str, str], explicit: Set[str]) -> None:
    def derive(key: str, value: str) -> None:
        if key not in explicit:
            values[key] = value

    derive(
        "FC_WEBSERVER_URL",
        "http://{}:{}".format(values.get("FC_IP", ""), values.get("FC_WEBSERVER_PORT", "8080")),
    )
    derive(
        "FC_TCP_URL",
        "tcp://{}:{}".format(values.get("FC_IP", ""), values.get("FC_MAVLINK_TCP_PORT", "5760")),
    )
    derive(
        "MAVLINK_URL",
        "udpin://{}:{}".format(values.get("MAVLINK_BIND_IP", "0.0.0.0"), values.get("MAVLINK_UDP_PORT", "14540")),
    )
    derive(
        "RTSP_URL",
        "rtsp://{}:{}/{}.264".format(
            values.get("SIYI_CAMERA_IP", ""),
            values.get("SIYI_RTSP_PORT", "8554"),
            values.get("STREAM_TYPE", "sub"),
        ),
    )
    derive(
        "GO2RTC_API_URL",
        "http://{}:{}".format(
            values.get("GO2RTC_API_HOST", "localhost"),
            values.get("GO2RTC_API_PORT", "1984"),
        ),
    )
    connection = values.get("FC_CONNECTION", "").strip().lower()
    if connection == "tcp":
        values["FC_CONNECTION"] = values["FC_TCP_URL"]
    elif connection == "udp":
        # MAVSDK's UDP connection form listens on every interface by default.
        values["FC_CONNECTION"] = "udp://:{}".format(values.get("MAVLINK_UDP_PORT", "14540"))


def is_explicitly_configured(key: str) -> bool:
    """Return whether the latest runtime load supplied *key* directly."""
    return key in _LAST_EXPLICIT


def _resolve_file_environment(env_file: Path) -> Dict[str, str]:
    """Resolve defaults plus a selected EnvironmentFile for helper commands.

    This intentionally has no process or path fallbacks: installers use ``get``
    to discover only file-backed configuration, and an unset path must remain
    unset there.
    """
    values: Dict[str, str] = {}
    sources: Dict[str, int] = {}
    explicit: Set[str] = set()
    _overlay(values, parse_environment_file(_default_example_for(env_file)), 0, sources, explicit)
    _overlay(values, parse_environment_file(env_file.parent / "forwarder.env"), 1, sources, explicit)
    _overlay(values, parse_environment_file(env_file), 2, sources, explicit)
    _normalize_hub_aliases(values, sources)
    _expand_network_suffixes(values)
    _derive_values(values, explicit)
    return values


def render_go2rtc_config(env_file: Path, output_file: Path) -> None:
    """Render go2rtc configuration from resolved companion values.

    The output contains only stream/listen settings; it intentionally never
    includes a Hub API key or any other companion credentials.
    """
    values = _resolve_file_environment(env_file)
    rtsp_url = values.get("RTSP_URL", "")
    if not rtsp_url:
        raise ValueError("RTSP_URL is required (or set SIYI_CAMERA_IP and SIYI_RTSP_PORT)")
    api_host = values.get("GO2RTC_API_HOST", "localhost")
    api_port = values.get("GO2RTC_API_PORT", "1984")
    webrtc_port = values.get("GO2RTC_WEBRTC_PORT", "8555")
    content = "\n".join([
        "streams:",
        "  camera: " + json.dumps(rtsp_url),
        "",
        "api:",
        "  listen: " + json.dumps("{}:{}".format(api_host, api_port)),
        "",
        "webrtc:",
        "  listen: " + json.dumps(":" + str(webrtc_port)),
        "  candidates:",
        "    - " + json.dumps("stun:{}".format(webrtc_port)),
        "",
        "rtsp:",
        '  listen: ""',
        "",
        "log:",
        "  level: info",
        "",
    ])
    _write_atomic(output_file, content)


def render_fc_params(env_file: Path, output_file: Path) -> None:
    """Render an importable GCS parameter file for firmware_puller.lua.

    ``FWPULL_ENABLE`` is deliberately absent: importing a network endpoint
    should not implicitly turn on firmware retrieval.  The operator controls
    that safety switch separately on the flight controller.
    """
    values = _resolve_file_environment(env_file)
    try:
        companion_ip = ipaddress.IPv4Address(values.get("COMPANION_IP", ""))
    except ipaddress.AddressValueError as error:
        raise ValueError("COMPANION_IP must be a valid IPv4 address") from error
    try:
        firmware_port = int(values.get("FIRMWARE_SERVER_PORT", ""))
    except ValueError as error:
        raise ValueError("FIRMWARE_SERVER_PORT must be an integer from 1 to 65535") from error
    if not 1 <= firmware_port <= 65535:
        raise ValueError("FIRMWARE_SERVER_PORT must be from 1 to 65535")
    if companion_ip.packed[0] == 0 or companion_ip.packed[0] >= 224:
        raise ValueError("COMPANION_IP must be a unicast IPv4 address accepted by firmware_puller.lua")

    octets = str(companion_ip).split(".")
    content = "\n".join(
        [f"FWPULL_PI_IP{index} {octet}" for index, octet in enumerate(octets)]
        + [f"FWPULL_PORT {firmware_port}", ""]
    )
    _write_atomic(output_file, content)


def load_environment() -> Dict[str, str]:
    """Load companion configuration into ``os.environ`` and return its values.

    Precedence is: the adjacent distributable template defaults, legacy ``forwarder.env``, the
    adjacent ``.env``, an optional ``QUIVER_ENV_FILE`` overlay, then variables
    already supplied by the service manager/process.  All input is literal;
    nothing is expanded or executed.
    """
    values: Dict[str, str] = {}
    sources: Dict[str, int] = {}
    explicit: Set[str] = set()

    # Example values are defaults, but count as known values for normalisation.
    _overlay(values, parse_environment_file(_SCRIPT_DIR / _TEMPLATE_NAME), 0, sources, explicit)
    _overlay(values, parse_environment_file(_SCRIPT_DIR / "forwarder.env"), 1, sources, explicit)
    _overlay(values, parse_environment_file(_SCRIPT_DIR / ".env"), 2, sources, explicit)

    process_values = _process_environment()
    configured_file = process_values.get("QUIVER_ENV_FILE")
    if configured_file:
        configured_path = Path(configured_file).expanduser()
        if not configured_path.is_file():
            raise FileNotFoundError(
                "QUIVER_ENV_FILE was specified but does not exist: {}".format(configured_path)
            )
        _overlay(values, parse_environment_file(configured_path), 3, sources, explicit)
    _overlay(values, process_values, 4, sources, explicit)

    _normalize_hub_aliases(values, sources)
    _expand_network_suffixes(values)
    _derive_values(values, explicit)

    # Installer-populated paths are optional.  Keep fallback locations portable
    # and relative to this helper rather than embedding a developer home path.
    if not values.get("INSTALL_DIR"):
        values["INSTALL_DIR"] = str(_SCRIPT_DIR)
    if not values.get("CONFIG_DIR"):
        values["CONFIG_DIR"] = str(_SCRIPT_DIR)
    if not values.get("PARSERS_DIR"):
        values["PARSERS_DIR"] = str(_SCRIPT_DIR / "parsers")

    os.environ.update(values)
    _LAST_EXPLICIT.clear()
    _LAST_EXPLICIT.update(explicit)
    _MANAGED_ENVIRONMENT.clear()
    _MANAGED_ENVIRONMENT.update(values)
    return dict(values)


def is_explicit(key: str) -> bool:
    """Whether the last load supplied a setting rather than deriving it."""
    return key in _LAST_EXPLICIT


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage literal companion EnvironmentFile settings")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="add missing defaults without overwriting values")
    init_parser.add_argument("env_file", type=Path)

    get_parser = subparsers.add_parser("get", help="print one resolved literal value")
    get_parser.add_argument("env_file", type=Path)
    get_parser.add_argument("key")

    set_parser = subparsers.add_parser("set", help="set one or more literal KEY VALUE pairs")
    set_parser.add_argument("env_file", type=Path)
    set_parser.add_argument("pairs", nargs="+")

    render_parser = subparsers.add_parser(
        "render-go2rtc", help="render resolved camera settings into a go2rtc YAML file"
    )
    render_parser.add_argument("env_file", type=Path)
    render_parser.add_argument("output_file", type=Path)

    fc_params_parser = subparsers.add_parser(
        "render-fc-params", help="render firmware_puller.lua GCS parameter values"
    )
    fc_params_parser.add_argument("env_file", type=Path)
    fc_params_parser.add_argument("output_file", type=Path)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "init":
        initialize_environment(args.env_file)
        return 0
    if args.command == "get":
        print(_resolve_file_environment(args.env_file).get(args.key, ""))
        return 0
    if args.command == "render-go2rtc":
        render_go2rtc_config(args.env_file, args.output_file)
        return 0
    if args.command == "render-fc-params":
        render_fc_params(args.env_file, args.output_file)
        return 0
    if len(args.pairs) % 2:
        _build_parser().error("set requires KEY VALUE pairs")
    pairs = list(zip(args.pairs[::2], args.pairs[1::2]))
    set_environment_values(args.env_file, pairs)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"companion_config: {error}", file=sys.stderr)
        raise SystemExit(2)
