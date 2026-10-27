; Keep the first interactive language choice, but let pinned Tauri/MUI reuse
; its HKCU language on subsequent /P /UPDATE installs. ALWAYSSHOW would block
; the supported passive update path before the installation even begins.
; Never allow an ignored extraction failure to certify an installed update.
AllowSkipFiles off
!include "${__FILEDIR__}\lsh-owned-resources.nsh"
!include "${__FILEDIR__}\signed-update-lock.nsh"

!macro NSIS_HOOK_POSTINSTALL
  IfErrors 0 +2
    Abort "An installation step failed. Please repair the installation."
  !insertmacro LR_LSH_VERIFY_SLOT
  ; The pinned template's GetSize clears earlier NSIS errors.
  ClearErrors
  WriteUninstaller "$INSTDIR\uninstall.exe"
  IfErrors 0 +2
    Abort "Cannot write LuckyRay's uninstaller. Please repair the installation."
  ReadRegStr $0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${If} $0 != "${VERSION}"
    Abort "Installed version registration failed. Please repair the installation."
  ${EndIf}
  ReadRegStr $0 SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $0 != "${MAINBINARYNAME}.exe"
    Abort "Executable registration failed. Please repair the installation."
  ${EndIf}
  ; MUI skips its language dialog (and its persistence) during /S. Record the
  ; actual NSIS language for silent first installs as well, using Tauri's key.
  ClearErrors
  WriteRegStr HKCU "${MANUPRODUCTKEY}" "Installer Language" $LANGUAGE
  IfErrors 0 +2
    Abort "Cannot preserve LuckyRay's installer language. Please repair the installation."
  ClearErrors
  CreateDirectory "$LOCALAPPDATA\LuckyRay\NativeMessaging"
  IfErrors 0 +2
    Abort "Cannot create the Native Messaging directory."
  ClearErrors
  ExecWait '"$INSTDIR\luckyray-native-host.exe" --install-manifest "$LOCALAPPDATA\LuckyRay\NativeMessaging\com.luckyray.desktop.json"' $0
  IfErrors 0 +2
    Abort "Cannot launch LuckyRay Native Messaging registration."
  ${If} $0 != 0
    Abort "LuckyRay Native Messaging host manifest installation failed."
  ${EndIf}
  WriteRegStr HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.luckyray.desktop" "" "$LOCALAPPDATA\LuckyRay\NativeMessaging\com.luckyray.desktop.json"
  IfErrors 0 +2
    Abort "Cannot register LuckyRay Native Messaging for Edge."
  WriteRegStr HKCU "Software\Google\Chrome\NativeMessagingHosts\com.luckyray.desktop" "" "$LOCALAPPDATA\LuckyRay\NativeMessaging\com.luckyray.desktop.json"
  IfErrors 0 +2
    Abort "Cannot register LuckyRay Native Messaging for Chrome."
  ClearErrors
  FileOpen $7 "$INSTDIR\luckyray-install-complete.txt" w
  IfErrors 0 +2
    Abort "Cannot record completed installation. Please run the installer again."
  FileWrite $7 "com.luckyray.desktop|${VERSION}"
  FileClose $7
  IfErrors 0 +2
    Abort "Cannot record completed installation. Please run the installer again."
  Delete "$INSTDIR\luckyray-install-in-progress.txt"
  IfErrors 0 +2
    Abort "Installation state could not be finalized. Please run the installer again."
  !insertmacro LR_UPDATE_RELEASE
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.luckyray.desktop"
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.luckyray.desktop"
  Delete "$LOCALAPPDATA\LuckyRay\NativeMessaging\com.luckyray.desktop.json"
  RMDir "$LOCALAPPDATA\LuckyRay\NativeMessaging"
  Delete "$INSTDIR\luckyray-install-complete.txt"
  Delete "$INSTDIR\luckyray-install-in-progress.txt"
  !insertmacro LR_UPDATE_RELEASE
  !insertmacro LR_LSH_UNINSTALL_EMPTY_NAMESPACE
  RMDir "$INSTDIR" ; Nonrecursive: only an empty directory after marker cleanup.
!macroend
