; Downpour NSIS installer hooks.
;
; Tauri's generated installer creates a Start Menu entry but no desktop
; shortcut. A download manager is something people launch constantly and pin,
; so it gets one -- created on install and, importantly, removed on uninstall.
; An orphaned desktop icon pointing at a deleted binary is the classic sign of
; a sloppy installer.

!macro NSIS_HOOK_POSTINSTALL
  ; $INSTDIR is wherever the user chose; MAINBINARYNAME is filled in by Tauri.
  CreateShortcut "$DESKTOP\Downpour.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\Downpour.lnk"
!macroend
