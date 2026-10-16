; Cooperative gate shared with desktop_app_update/ownership.rs.
; Held BEFORE writes and released only AFTER native-messaging registration.
; Unlike Tauri's default process check, this never kills an application.
Var LRUpdateMutex

; NSIS can otherwise enter its WiX removal page before PREINSTALL. Refuse
; that migration for /UPDATE rather than silently uninstalling another package.
!ifdef MUI_CUSTOMFUNCTION_GUIINIT
  !error "Another GUI init hook exists; compose the update migration guard explicitly."
!endif
!define MUI_CUSTOMFUNCTION_GUIINIT LR_UPDATE_GUI_INIT
Function LR_UPDATE_GUI_INIT
  Push $0
  Push $1
  Push $R0
  Push $R1
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $R0
  ${IfNot} ${Errors}
    SetRegView 32
    Call LR_UPDATE_SCAN_MSI
    SetRegView lastused
    SetRegView 64
    Call LR_UPDATE_SCAN_MSI
    SetRegView lastused
  ${EndIf}
  Pop $R1
  Pop $R0
  Pop $1
  Pop $0
FunctionEnd
Function LR_UPDATE_SCAN_MSI
  StrCpy $0 0
  lr_msi_scan:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" lr_msi_done
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    StrCmp $R0 "LuckyRay" 0 lr_msi_scan
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 "" lr_msi_scan
    MessageBox MB_ICONSTOP|MB_OK "A LuckyRay MSI installation was found. Automatic migration was stopped. Use the official installer to manage this installation."
    SetErrorLevel 2
    Quit
  lr_msi_done:
FunctionEnd

!macro LR_UPDATE_ACQUIRE
  ${If} $LRUpdateMutex == ""
    System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Global\LuckyRayDesktopSignedUpdateV1") p.r8'
    ${If} $8 == 0
      Abort "Cannot verify that LuckyRay is closed. Installation was stopped."
    ${EndIf}
    ; Wait for the updater parent to exit. A different live app retains ownership.
    System::Call 'kernel32::WaitForSingleObject(p r8, i 30000) i.r9'
    ${If} $9 != 0
    ${AndIf} $9 != 128
      System::Call 'kernel32::CloseHandle(p r8)'
      Abort "LuckyRay is still running. Close it normally before installing."
    ${EndIf}
    StrCpy $LRUpdateMutex $8
  ${EndIf}
!macroend

!macro LR_UPDATE_RELEASE
  ${If} $LRUpdateMutex != ""
    System::Call 'kernel32::ReleaseMutex(p $LRUpdateMutex)'
    System::Call 'kernel32::CloseHandle(p $LRUpdateMutex)'
    StrCpy $LRUpdateMutex ""
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro LR_UPDATE_ACQUIRE
  SetOverwrite on
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LR_UPDATE_ACQUIRE
!macroend

; utils.nsh is included before installerHooks by the pinned Tauri template.
; Replace its passive-mode force-termination with a read-only Restart Manager check.
!ifmacrondef CheckIfAppIsRunning
  !error "Tauri process guard changed; review updater installer safety before packaging."
!endif
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executablePath productName
  !insertmacro LR_UPDATE_ACQUIRE
  System::Alloc 66
  Pop $1
  System::Call 'rstrtmgr::RmStartSession(*i .r0, i 0, p r1) i.r4'
  System::Free $1
  ${If} $4 != 0
    Abort "Cannot inspect running LuckyRay processes. Installation was stopped."
  ${EndIf}
  ${GetFileName} "${executablePath}" $5
  System::Call '*(&w32768 "$INSTDIR\$5") p.r2'
  System::Call '*(p r2) p.r3'
  System::Call 'rstrtmgr::RmRegisterResources(i r0, i 1, p r3, i 0, p 0, i 0, p 0) i.r4'
  System::Free $3
  System::Free $2
  ${If} $4 != 0
    System::Call 'rstrtmgr::RmEndSession(i r0)'
    Abort "Cannot inspect running LuckyRay processes. Installation was stopped."
  ${EndIf}
  System::Call 'rstrtmgr::RmGetList(i r0, *i .r1, *i 0, p 0, *i .r2) i.r4'
  System::Call 'rstrtmgr::RmEndSession(i r0)'
  ${If} $4 != 0
    Abort "LuckyRay may still be running. Close it normally, then retry."
  ${EndIf}
  ; A canceled handoff has no marker; interruption after this point requires repair.
  ClearErrors
  FileOpen $7 "$INSTDIR\luckyray-install-in-progress.txt" w
  IfErrors 0 +2
    Abort "Cannot record installation state. Installation was stopped."
  FileWrite $7 "pending"
  FileClose $7
  IfErrors 0 +2
    Abort "Cannot record installation state. Installation was stopped."
!macroend
