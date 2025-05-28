#!/bin/bash

FFMPEG="./native_host/bin/mac/bin/ffmpeg"
FFPROBE="./native_host/bin/mac/bin/ffprobe"

# Test URLs
HLS_URL="https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8"
DASH_URL="https://dash.akamaized.net/dash264/TestCases/1a/netflix/exMPD_BIP_TC1.mpd"

echo "Testing HLS streaming..."
$FFPROBE -v quiet -print_format json -show_format -show_streams "$HLS_URL"

echo "Testing DASH streaming..."
$FFPROBE -v quiet -print_format json -show_format -show_streams "$DASH_URL"

echo "Testing short segment download with HLS..."
$FFMPEG -i "$HLS_URL" -t 10 -c copy test_hls_output.mp4

echo "Testing short segment download with DASH..."
$FFMPEG -i "$DASH_URL" -t 10 -c copy test_dash_output.mp4

echo "All tests completed!"
