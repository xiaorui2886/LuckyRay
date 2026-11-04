#!/usr/bin/env bash
# Synthetic-only fixtures for the LGPL bundle live checks, encoded by the
# bundled (LGPL, no x264) ffmpeg itself: mpeg4/aac, a 90-degree display matrix.
# usage: live-fixtures.sh <bundled-ffmpeg> <out-dir>
set -euo pipefail
ff=$1; out=$2
mkdir -p "$out"
q=(-nostdin -hide_banner -loglevel error -y)
"$ff" "${q[@]}" -f lavfi -i testsrc=size=64x48:rate=10 -t 1 -c:v mpeg4 -pix_fmt yuv420p "$out/clip.mkv"
"$ff" "${q[@]}" -f lavfi -i testsrc=duration=6:size=320x180:rate=25 -c:v mpeg4 -pix_fmt yuv420p "$out/upright.mp4"
"$ff" "${q[@]}" -display_rotation:v:0 90 -i "$out/upright.mp4" -c copy "$out/rotated.mp4"
"$ff" "${q[@]}" -f lavfi -i sine=frequency=440:duration=2 -c:a aac "$out/audio.m4a"
"$ff" "${q[@]}" -f lavfi -i testsrc=duration=30:size=320x180:rate=25 -c:v mpeg4 -pix_fmt yuv420p "$out/long.mp4"
