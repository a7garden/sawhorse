#!/bin/sh
# Install the extracted macOS/Linux CLI without administrator permissions.
set -eu
sawhorse_source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sawhorse_bin_dir=${1:-"$HOME/.local/bin"}
mkdir -p "$sawhorse_bin_dir"
sawhorse_temp=$(mktemp "$sawhorse_bin_dir/.sawhorse.XXXXXX")
trap 'rm -f "$sawhorse_temp"' EXIT HUP INT TERM
cp "$sawhorse_source_dir/sawhorse" "$sawhorse_temp"
chmod 755 "$sawhorse_temp"
mv -f "$sawhorse_temp" "$sawhorse_bin_dir/sawhorse"
"$sawhorse_bin_dir/sawhorse" --version
case ":$PATH:" in
  *":$sawhorse_bin_dir:"*) ;;
  *) printf 'Add this directory to your shell PATH: %s\n' "$sawhorse_bin_dir" ;;
esac
