"""Retain native environment options while replacing test execution controls."""
import json
import os
from pathlib import Path
import shlex
import sys

import pytest
from _pytest.config.findpaths import determine_setup

# These alter selection, repetition, coverage or reporting owned by this call.
OWNED_VALUES = {
    "--maxfail", "--reruns", "--reruns-delay", "--count", "--junitxml",
    "--junit-xml", "--junit-prefix", "--cov-report", "--cov-config",
    "--cov-fail-under", "-k", "-m", "--ignore", "--ignore-glob", "--deselect",
}
OWNED_FLAGS = {
    "-x", "--exitfirst", "--lf", "--last-failed", "--ff", "--failed-first",
    "--nf", "--new-first", "--sw", "--stepwise", "--stepwise-skip",
    "--co", "--collect-only", "--no-cov", "--cov-branch", "--cov-append",
    "--no-cov-on-fail", "--pyargs",
}
# Runner-independent fixture/import/logging options preserve their native meaning.
VALUES = {
    "-p", "--import-mode", "--basetemp", "--confcutdir", "-W", "--pythonwarnings",
    "--capture", "--tb", "--color", "--code-highlight", "--durations",
    "--durations-min", "--verbosity", "--log-level", "--log-format",
    "--log-date-format", "--log-cli-level", "--log-cli-format", "--log-cli-date-format",
    "--log-file", "--log-file-level", "--log-file-format", "--log-file-date-format",
    "--assert", "--show-capture", "-o", "--override-ini",
}
FLAGS = {
    "--strict", "--strict-config", "--strict-markers", "--disable-warnings",
    "--disable-pytest-warnings", "--noconftest", "--showlocals", "--no-showlocals",
    "--full-trace", "--verbose", "--quiet", "-s", "-q", "-v",
}

def retained(tokens):
    kept = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        option, separator, value = token.partition("=")
        index += 1
        if option in OWNED_FLAGS:
            continue
        if option == "--cov":
            if not separator and index < len(tokens) and not tokens[index].startswith("-"):
                index += 1
            continue
        if option in OWNED_VALUES or option in VALUES:
            if not separator:
                if index == len(tokens):
                    raise pytest.UsageError(f"Missing native option value: {option}")
                value = tokens[index]
                index += 1
            if option in VALUES:
                if option in {"-o", "--override-ini"} and value.split("=", 1)[0] in {"addopts", "junit_family", "junit_logging"}:
                    continue
                kept.extend([option, value])
            continue
        if option in FLAGS or (token.startswith("-") and set(token[1:]) <= {"q", "v"}):
            kept.append(token)
            continue
        raise pytest.UsageError(f"Unsupported native addopts control {token!r}; move fixture/setup configuration to native config, or reconcile this plugin option explicitly")
    return kept

def main():
    # Match python -m pytest import context while keeping this helper packaged.
    sys.path.insert(0, str(Path.cwd()))
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    _, _, ini, _ = determine_setup(
        inifile=None, args=payload["selected"], rootdir_cmd_arg=None,
        invocation_dir=Path.cwd(), override_ini=[],
    )
    addopts = ini.get("addopts", [])
    addopts = getattr(addopts, "value", addopts)
    if isinstance(addopts, str):
        addopts = shlex.split(addopts)
    options = retained([*addopts, *shlex.split(os.environ.pop("PYTEST_ADDOPTS", ""))])
    measurement = payload.get("coverage")
    if measurement is None:
        return pytest.main([*options, *payload["args"]])
    from coverage import Coverage
    sources = measurement["sources"]
    collector = Coverage(
        data_file=measurement["data_file"], branch=False,
        source=sorted({str(Path(source).parent) for source in sources}),
        omit=[], config_file=True,
    )
    collector.set_option("report:include_namespace_packages", measurement["include_namespace_packages"])
    collector.start()
    try:
        result = pytest.main([*options, *payload["args"]])
    finally:
        collector.stop()
        collector.save()
        collector.json_report(morfs=sources, outfile=measurement["report"], include=sources, omit=[])
    return result

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except pytest.UsageError as error:
        print(f"Unsupported pytest configuration: {error}", file=sys.stderr)
        raise SystemExit(4)
