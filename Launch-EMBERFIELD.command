#!/bin/bash
# Double-click this file in Finder to start EMBERFIELD on a Mac.
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
"$project_dir/Launch-EMBERFIELD.sh" "$@"
status=$?
if [ "$status" -ne 0 ]; then
    printf '\n%s' 'Press Return to close this window. '
    read -r
fi
exit "$status"
