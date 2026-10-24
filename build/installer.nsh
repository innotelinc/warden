; ---------------------------------------------------------------------------
; WARDEN NSIS hooks
;
; electron-builder writes `InstallLocation` into its own bookkeeping key
; (Software\{APP_GUID}) and uses it for upgrade detection, but Windows' Apps &
; Features and most software inventory / patch-management tools read
; `InstallLocation` from the *uninstall* key instead. Without this the
; "open file location" action does nothing and asset scans report WARDEN with
; no path.
;
; customInstall runs from installSection.nsh immediately after
; registryAddInstallInfo, so the uninstall key already exists and $INSTDIR is
; final. The uninstaller deletes the whole key, so there is nothing to undo.
; SHELL_CONTEXT keeps this correct for both per-user and per-machine installs.
; ---------------------------------------------------------------------------

!macro customInstall
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
!macroend
