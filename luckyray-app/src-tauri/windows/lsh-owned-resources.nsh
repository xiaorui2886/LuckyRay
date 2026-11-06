; Only this namespace belongs to this resource deployment protocol. Legacy
; flat engine/host directories and all AppData/user files are untouched.
!define LR_LSH_PARENT "lr-lsh"
!define LR_LSH_SLOT "1910-2"
!define LR_LSH_OWNER_FILE "luckyray-lsh-layout-v1.txt"
!define LR_LSH_OWNER_TEXT "com.luckyray.desktop|lr-lsh|v1"

!macro LR_LSH_PREPARE_SLOT
  Push $0
  Push $1
  Push $2
  Push $7
  Push $R0
  Push $R1
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\${LR_LSH_PARENT}") i.r0'
  ${If} $0 != -1
    IntOp $1 $0 & 0x410
    ${If} $1 != 16
      Abort "LSH resource namespace is not an ordinary directory. Installation stopped."
    ${EndIf}
    IfFileExists "$INSTDIR\${LR_LSH_OWNER_FILE}" +2 0
      Abort "Unrecognized LSH resource namespace. Existing files were preserved."
  ${EndIf}
  IfFileExists "$INSTDIR\${LR_LSH_OWNER_FILE}" lr_lsh_check_owner lr_lsh_create_owner
  lr_lsh_check_owner:
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\${LR_LSH_OWNER_FILE}") i.r0'
    IntOp $1 $0 & 0x410
    ${If} $1 != 0
      Abort "LSH ownership record is not an ordinary file. Installation stopped."
    ${EndIf}
    ClearErrors
    FileOpen $7 "$INSTDIR\${LR_LSH_OWNER_FILE}" r
    IfErrors 0 +2
      Abort "Cannot read LSH ownership record. Existing files were preserved."
    FileSeek $7 0 END $R0
    FileSeek $7 0 SET
    FileRead $7 $0 128
    FileClose $7
    StrLen $R1 $0
    ${If} $R0 != $R1
      Abort "Unrecognized LSH ownership record. Existing files were preserved."
    ${EndIf}
    ${If} $0 != "${LR_LSH_OWNER_TEXT}"
    ${AndIf} $0 != "${LR_LSH_OWNER_TEXT}$\n"
    ${AndIf} $0 != "${LR_LSH_OWNER_TEXT}$\r$\n"
      Abort "Unrecognized LSH ownership record. Existing files were preserved."
    ${EndIf}
    Goto lr_lsh_owner_ready
  lr_lsh_create_owner:
    ; Atomic marker precedes namespace creation, so a killed extraction has a
    ; recognizable owner on repair. Never overwrite an unrecognized record.
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    System::Call 'kernel32::GetTickCount() i.r1'
    StrCpy $R0 "$INSTDIR\${LR_LSH_OWNER_FILE}.$0-$1.pending"
    IfFileExists "$R0" 0 +2
      Abort "Cannot reserve LSH ownership record. Installation stopped."
    ClearErrors
    FileOpen $7 "$R0" w
    IfErrors 0 +2
      Abort "Cannot create LSH ownership record. Installation stopped."
    FileWrite $7 "${LR_LSH_OWNER_TEXT}$\r$\n"
    FileClose $7
    IfErrors 0 +2
      Abort "Cannot write LSH ownership record. Installation stopped."
    Rename "$R0" "$INSTDIR\${LR_LSH_OWNER_FILE}"
    IfErrors 0 +2
      Abort "Cannot commit LSH ownership record. Installation stopped."
  lr_lsh_owner_ready:
    System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\${LR_LSH_PARENT}\${LR_LSH_SLOT}") i.r0'
    ${If} $0 != -1
      IntOp $1 $0 & 0x410
      ${If} $1 != 16
        Abort "LSH slot is not an ordinary directory. Existing files were preserved."
      ${EndIf}
      StrCpy $2 0
      ${Do}
        IntOp $2 $2 + 1
        ${If} $2 > 100
          Abort "LSH backup slots are full. Existing files were preserved."
        ${EndIf}
        System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\${LR_LSH_PARENT}\${LR_LSH_SLOT}.saved-$2") i.r0'
        ${If} $0 == -1
          ClearErrors
          Rename "$INSTDIR\${LR_LSH_PARENT}\${LR_LSH_SLOT}" "$INSTDIR\${LR_LSH_PARENT}\${LR_LSH_SLOT}.saved-$2"
          IfErrors 0 +2
            Abort "Cannot retain the previous LSH slot. Installation stopped."
          ${ExitDo}
        ${EndIf}
      ${Loop}
    ${EndIf}
    ClearErrors
    CreateDirectory "$INSTDIR\${LR_LSH_PARENT}\${LR_LSH_SLOT}"
    IfErrors 0 +2
      Abort "Cannot create a clean LSH slot. Installation stopped."
  Pop $R1
  Pop $R0
  Pop $7
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro LR_LSH_VERIFY_SLOT
  ClearErrors
  ExecWait '"$INSTDIR\luckyray-app.exe" --verify-installed-lsh' $0
  IfErrors 0 +2
    Abort "Cannot verify installed LSH resources. Run the installer again to repair."
  ${If} $0 != 0
    Abort "Installed LSH resource verification failed. Previous slots are preserved; run the installer again to repair."
  ${EndIf}
!macroend

!macro LR_LSH_UNINSTALL_EMPTY_NAMESPACE
  ; Only empty directories/our record can go. Retained slots remain recoverable.
  ClearErrors
  RMDir "$INSTDIR\${LR_LSH_PARENT}"
  IfErrors +2 0
    Delete "$INSTDIR\${LR_LSH_OWNER_FILE}"
!macroend
