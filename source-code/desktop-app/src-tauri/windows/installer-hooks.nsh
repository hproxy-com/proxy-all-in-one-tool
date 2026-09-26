; Hooks into Tauri's NSIS installer (tauri.conf.json, bundle.windows.nsis.installerHooks).
;
; The app was called "hproxy-checker" until 2026-09-24 and is "HProxy" since.
; Tauri's installer keys its registry entry, its folder and its shortcuts on the product name,
; so installing HProxy over hproxy-checker would leave both side by side, two entries in the
; Start menu and in Apps. Before any file is copied, an earlier hproxy-checker is uninstalled
; silently: its program, its Start menu entry, its desktop shortcut, its registry keys. Never
; its data: settings, lists and history live under the identifier com.hproxy.checker, which
; did not change, and the old uninstaller only removes them when a person ticks that box.
; After the install, the Start menu entry, a desktop shortcut and a start-with-the-computer
; entry it had come back under the new name (the autostart plugin names its Run value after
; the product name). They are made here, not left to Tauri's template, because the app's
; updater runs this installer with /UPDATE, and in that mode the template creates no shortcut
; at all, it only refreshes one that exists: an update from hproxy-checker would have left
; HProxy running with no Start menu entry.
;
; The program file keeps its name, hproxy-checker.exe (mainBinaryName): the installer closes a
; running copy by that name, and a program named "hproxy" runs as the command-line tool.

!define OLD_PRODUCTNAME "hproxy-checker"
!define OLD_MANUFACTURER "hproxy"
!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_PRODUCTNAME}"
!define OLD_PRODUCTKEY "Software\${OLD_MANUFACTURER}\${OLD_PRODUCTNAME}"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define STARTUP_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"

Var OldInstallDir
Var OldHadStartMenuShortcut
Var OldHadDesktopShortcut
Var OldStartedWithComputer

!macro NSIS_HOOK_PREINSTALL
  StrCpy $OldHadStartMenuShortcut 0
  StrCpy $OldHadDesktopShortcut 0
  StrCpy $OldStartedWithComputer 0
  ; The folder the old installer recorded, without quotes.
  ReadRegStr $OldInstallDir SHCTX "${OLD_PRODUCTKEY}" ""
  ${If} $OldInstallDir != ""
  ${AndIf} ${FileExists} "$OldInstallDir\uninstall.exe"
    ${If} ${FileExists} "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
      StrCpy $OldHadStartMenuShortcut 1
    ${EndIf}
    ${If} ${FileExists} "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
      StrCpy $OldHadDesktopShortcut 1
    ${EndIf}
    ReadRegStr $0 HKCU "${RUN_KEY}" "${OLD_PRODUCTNAME}"
    ${If} $0 != ""
      StrCpy $OldStartedWithComputer 1
    ${EndIf}
    DetailPrint "Removing the earlier hproxy-checker from $OldInstallDir"
    ; _?= runs the uninstaller in place and waits for it; without /UPDATE it also removes the
    ; shortcuts. In place it cannot delete itself or its folder, so that is done here.
    ExecWait '"$OldInstallDir\uninstall.exe" /S _?=$OldInstallDir' $0
    Delete "$OldInstallDir\uninstall.exe"
    RMDir "$OldInstallDir"
  ${EndIf}
  ; Whatever the old uninstaller left of its keys (it removes them itself when it runs).
  DeleteRegKey SHCTX "${OLD_UNINSTKEY}"
  DeleteRegKey SHCTX "${OLD_PRODUCTKEY}"
  DeleteRegKey /ifempty SHCTX "Software\${OLD_MANUFACTURER}"
  ${If} $OldStartedWithComputer = 1
    DeleteRegValue HKCU "${RUN_KEY}" "${OLD_PRODUCTNAME}"
    DeleteRegValue HKCU "${STARTUP_APPROVED_KEY}" "${OLD_PRODUCTNAME}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Each with the app id the template gives its own shortcuts (taskbar grouping,
  ; notifications): SetLnkAppUserModelId, from the template's utils.nsh.
  ${If} $OldHadStartMenuShortcut = 1
  ${AndIfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} $OldHadDesktopShortcut = 1
  ${AndIfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} $OldStartedWithComputer = 1
    ; The same value tauri-plugin-autostart writes (auto-launch: "<program> <args>").
    WriteRegStr HKCU "${RUN_KEY}" "${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe --background"
  ${EndIf}
!macroend

; The app puts its AI tool's folder on the user's PATH so a setup can say `hproxy`
; (src-tauri/src/tool.rs, with the note on-path.txt beside the tool). Uninstalling takes
; both away again, before the program's files go: the program does it itself
; (--forget-tool-path, src-tauri/src/main.rs), because these strings end at 1024
; characters and a longer PATH (one measured had 1087) would be written back cut short. An
; update (/UPDATE) leaves both, as the template leaves its own start-with-the-computer
; entry. The folder is this app's own (BUNDLEID), so a test product never touches the
; real app's entry. The install is per user, so $LOCALAPPDATA is the user's own.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --forget-tool-path "$LOCALAPPDATA\${BUNDLEID}\tool"'
  ${EndIf}
!macroend
