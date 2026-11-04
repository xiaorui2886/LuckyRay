#!/usr/bin/env bash
# T43: run a command against a throwaway Secret Service, or against none.
#
#   linux-secret-service-session.sh present <new-scratch-dir> -- command...
#   linux-secret-service-session.sh absent  <new-scratch-dir> -- command...
#
# present: a private dbus-run-session bus with a headless gnome-keyring whose
#          login keyring lives under the scratch HOME and is unlocked with a
#          random password that is generated here, piped once, never printed.
# absent:  DBUS_SESSION_BUS_ADDRESS points at a socket that does not exist, so
#          the Secret Service is unreachable and the product must refuse.
# Both modes isolate HOME/XDG so no real keyring is ever read or written, and
# drop DISPLAY so no unlock prompt can appear.
set -euo pipefail

if [ "${1:-}" = "__inner" ]; then
  shift
  password="$(head -c 32 /dev/urandom | base64 -w0)"
  printf '%s' "$password" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  unset password
  gnome-keyring-daemon --start --components=secrets >/dev/null
  # The daemon belongs to this private bus and exits when dbus-run-session
  # closes it; nothing outside the session is signalled.
  LUCKYRAY_LIVE_SECRET_SERVICE=present exec "$@"
fi

mode="${1:-}"; scratch="${2:-}"; separator="${3:-}"
if { [ "$mode" != present ] && [ "$mode" != absent ]; } || [ -z "$scratch" ] || [ "$separator" != "--" ] || [ "$#" -lt 4 ]; then
  echo "usage: $0 present|absent <new-scratch-dir> -- command..." >&2
  exit 2
fi
shift 3
mkdir -m 700 "$scratch"          # must be new: never reuse or adopt a directory
scratch="$(cd "$scratch" && pwd -P)"
mkdir -m 700 "$scratch/home" "$scratch/run"

# Toolchains keep resolving from the caller's home while HOME moves.
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export HOME="$scratch/home" XDG_RUNTIME_DIR="$scratch/run"
export XDG_DATA_HOME="$scratch/home/.local/share" XDG_CONFIG_HOME="$scratch/home/.config" XDG_CACHE_HOME="$scratch/home/.cache"
export RUST_BACKTRACE=0
unset DISPLAY WAYLAND_DISPLAY GNOME_KEYRING_CONTROL SSH_AUTH_SOCK DBUS_SESSION_BUS_ADDRESS

if [ "$mode" = absent ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$scratch/run/absent-bus"
  LUCKYRAY_LIVE_SECRET_SERVICE=absent exec "$@"
fi
exec dbus-run-session -- bash "${BASH_SOURCE[0]}" __inner "$@"
