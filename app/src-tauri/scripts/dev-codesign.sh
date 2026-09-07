#!/bin/sh
# Re-sign the dev binary before cargo executes it (wired in via
# ../.cargo/config.toml [target.*-apple-darwin] runner).
#
# Why: macOS Keychain ACLs trust code by its designated requirement (DR).
# The linker's ad-hoc signature has NO stable identity, so every rebuild
# produces a new CDHash and macOS asks for keychain access again — this is
# why the GitHub tab re-prompted for the keychain on every rebuild. Signing
# with a codesigning identity and a fixed identifier keeps the DR stable
# across rebuilds, so "Always Allow" can survive rebuilds. The identifier
# matches the release bundle identifier (tauri.conf.json); dev and installed
# builds share a trusted identity when their signing requirements also match.
#
# Identity selection: SAWHORSE_SIGN_IDENTITY override, else the first
# Developer ID Application identity, else any codesigning identity. If
# identity signing fails (locked keychain, missing intermediate, overridden
# certificate trust), the script
# falls back to plain ad-hoc so the app still runs — but ad-hoc's DR is the
# CDHash itself, so keychain prompts will recur until identity signing works.
set -eu

bin="$1"
shift

ids="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/^ *[0-9]) [0-9A-F]* "\(.*\)"$/\1/p' || true)"
identity="${SAWHORSE_SIGN_IDENTITY:-$(printf '%s\n' "$ids" | sed -n '/^Developer ID Application/{p;q;}')}"
if [ -z "$identity" ]; then
  identity="$(printf '%s\n' "$ids" | sed -n '1p')"
fi

if [ -n "$identity" ]; then
  if codesign --force --identifier com.a7garden.sawhorse --sign "$identity" "$bin"; then
    exec "$bin" "$@"
  fi
  echo "dev-codesign: identity signing failed; falling back to ad-hoc (keychain prompts may recur after a restart). For certificate chain errors, check the issuer certificate and restore code-signing certificate trust to system defaults: https://developer.apple.com/forums/thread/712043" >&2
fi
if ! codesign --force -s - --identifier com.a7garden.sawhorse "$bin" 2>/dev/null; then
  echo "dev-codesign: signing failed; keychain may prompt again" >&2
fi
exec "$bin" "$@"
