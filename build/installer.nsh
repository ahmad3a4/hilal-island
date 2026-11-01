; Extra uninstall step for the Hilal installer (picked up by electron-builder automatically).
; Removes the "Start with Windows" entry the app may have created, so nothing is left behind.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.github.ahmad3a4.hilal"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "io.github.ahmad3a4.hilal"
!macroend
