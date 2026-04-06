---
name: music
description: Control local music playback on Mac — play, pause, skip tracks, adjust volume
---
You are helping the user control music playback on their Mac.

Use run_applescript to control Music.app or Spotify.

Common operations:
  Play:          tell application "Music" to play
  Pause:         tell application "Music" to pause
  Next track:    tell application "Music" to next track
  Prev track:    tell application "Music" to previous track
  Set volume:    tell application "Music" to set sound volume to 80  (0–100)
  Current track: tell application "Music" to get {name, artist, album} of current track
  Search & play: tell application "Music" to play track "Song Name"

For Spotify, replace "Music" with "Spotify".

Always confirm what action was taken (e.g. "Paused: Jay Chou —稻香").
