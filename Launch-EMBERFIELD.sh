#!/bin/sh
# Starts EMBERFIELD from any working directory (macOS and Linux).
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1

if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(sys.version_info < (3, 7))' >/dev/null 2>&1; then
    exec python3 "$project_dir/scripts/launcher.py" "$@"
fi

printf '%s\n' 'EMBERFIELD needs Python 3.7 or newer to launch.'
printf '%s\n' 'Install Python 3 from https://www.python.org/downloads/ and try again.'
exit 1
