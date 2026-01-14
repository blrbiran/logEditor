#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVG_SOURCE="$ROOT_DIR/src/renderer/src/assets/electron.svg"
RESOURCE_PNG="$ROOT_DIR/resources/icon.png"
BUILD_DIR="$ROOT_DIR/build"
BUILD_PNG="$BUILD_DIR/icon.png"
BUILD_ICO="$BUILD_DIR/icon.ico"
BUILD_ICNS="$BUILD_DIR/icon.icns"
PNG_SIZE=512

require_file() {
  if [[ ! -f "$2" ]]; then
    echo "Error: $1 not found at $2" >&2
    exit 1
  fi
}

find_magick_bin() {
  if command -v magick >/dev/null 2>&1; then
    echo "magick"
  elif command -v convert >/dev/null 2>&1; then
    echo "convert"
  else
    echo ""
  fi
}

render_svg_to_png() {
  if command -v rsvg-convert >/dev/null 2>&1; then
    echo "   - Using rsvg-convert for SVG rasterization"
    rsvg-convert -w "$PNG_SIZE" -h "$PNG_SIZE" -b transparent \
      -o "$RESOURCE_PNG" "$SVG_SOURCE"
    return
  fi

  if command -v inkscape >/dev/null 2>&1; then
    echo "   - Using Inkscape for SVG rasterization"
    inkscape "$SVG_SOURCE" \
      --export-type=png \
      --export-filename="$RESOURCE_PNG" \
      --export-width="$PNG_SIZE" \
      --export-height="$PNG_SIZE" \
      --export-background=transparent \
      --export-background-opacity=0 >/dev/null 2>&1
    return
  fi

  if [[ -z "${MAGICK_BIN:-}" ]]; then
    echo "Error: Need rsvg-convert, Inkscape, or ImageMagick to rasterize the SVG." >&2
    exit 1
  fi

  echo "   - Using ImageMagick (${MAGICK_BIN}) for SVG rasterization"
  "$MAGICK_BIN" -background none -density $((PNG_SIZE * 4)) "$SVG_SOURCE" \
    -resize "${PNG_SIZE}x${PNG_SIZE}" -gravity center -extent "${PNG_SIZE}x${PNG_SIZE}" \
    "$RESOURCE_PNG"
}

main() {
  require_file "electron.svg" "$SVG_SOURCE"

  MAGICK_BIN="$(find_magick_bin)"
  if [[ -z "$MAGICK_BIN" ]]; then
    echo "Error: ImageMagick is required (magick or convert binary not found in PATH)." >&2
    exit 1
  fi

  mkdir -p "$ROOT_DIR/resources" "$BUILD_DIR"

  echo "1) Rendering SVG -> resources/icon.png ..."
  render_svg_to_png

  echo "2) Copying resources/icon.png -> build/icon.png ..."
  cp "$RESOURCE_PNG" "$BUILD_PNG"

  echo "3) Creating build/icon.ico ..."
  "$MAGICK_BIN" "$RESOURCE_PNG" \
    -define icon:auto-resize=256,128,96,64,48,32,16 \
    "$BUILD_ICO"

  echo "4) Creating build/icon.icns ..."
  "$MAGICK_BIN" "$RESOURCE_PNG" \
    -define icon:auto-resize=16,32,64,128,256,512 \
    "$BUILD_ICNS"

  echo "Done. Updated icons are in resources/ and build/."
}

main "$@"
