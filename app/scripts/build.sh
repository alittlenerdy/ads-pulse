#!/bin/bash
# Build Ads Pulse from source.
#
#   ./scripts/build.sh                 ad-hoc signed (no Apple developer account needed)
#   TEAM_ID=ABCDE12345 ./scripts/build.sh   signed with your Apple Development certificate
#   INSTALL=1 ./scripts/build.sh       also copy to /Applications and launch
#
# Optional with TEAM_ID: ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID (an App Store Connect API key)
# let xcodebuild create provisioning without signing in to Xcode.
# Needs Xcode 15+ and XcodeGen (brew install xcodegen).
set -euo pipefail
cd "$(dirname "$0")/.."
export BUNDLE_ID_PREFIX="${BUNDLE_ID_PREFIX:-com.example}"
command -v xcodegen >/dev/null || { echo "Install XcodeGen first: brew install xcodegen" >&2; exit 1; }
xcodegen generate --quiet

ARGS=(-project AdsPulse.xcodeproj -scheme AdsPulse -configuration Release -derivedDataPath build -destination 'platform=macOS')
if [[ -n "${TEAM_ID:-}" ]]; then
  ARGS+=(DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development" -allowProvisioningUpdates)
  if [[ -n "${ASC_KEY_PATH:-}" ]]; then
    ARGS+=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
  fi
fi
xcodebuild "${ARGS[@]}" build | grep -E "error:|warning: .*(deprecated)?|\*\* BUILD" || true

APP="build/Build/Products/Release/Ads Pulse.app"
[[ -d "$APP" ]] || { echo "Build failed; run xcodebuild without the filter to see why." >&2; exit 1; }
codesign --verify --deep --strict "$APP" && echo "built: $APP"

if [[ "${INSTALL:-0}" == "1" ]]; then
  pkill -x "Ads Pulse" 2>/dev/null || true
  rm -rf "/Applications/Ads Pulse.app"
  cp -R "$APP" /Applications/
  open "/Applications/Ads Pulse.app"
  echo "installed: /Applications/Ads Pulse.app"
fi
