-- Terminal.app driver for the demo recording.
-- Opens a positioned window and types commands at scheduled offsets.
-- t=0 is when this script starts. Aligns with STORYBOARD.md.

on type_line(theText)
  tell application "System Events"
    keystroke theText
    delay 0.4
    keystroke return
  end tell
end type_line

tell application "Terminal"
  activate
  if (count of windows) = 0 then
    do script ""
  end if
  set bounds of front window to {0, 0, 960, 1080}
  set custom title of front window to "modulewarden-demo"
  do script "cd /tmp/mw-demo && clear" in front window
end tell

delay 2
-- t=2: type the blocked install
my type_line("npm install dotenv@17.4.2")
-- The npm call itself takes ~5-10s before failing; the recording captures it.

delay 60
-- t≈64-72: focus terminal again (Chrome had focus). Type the successful install.
tell application "Terminal" to activate
delay 1
my type_line("npm install left-pad")

-- Hold the final frame
delay 18
