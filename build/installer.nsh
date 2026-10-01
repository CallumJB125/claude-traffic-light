; Plexiform uninstaller additions (wired in electron-builder.config.js, nsis.include).
;
; Before the app's files go, run it once with --uninstall-hooks so Claude
; Code, Cursor, Codex, Gemini and ~/.claude.json are not left with commands
; that point at a deleted exe. Not on an update (--updated): the new version
; is about to rewrite those commands itself. nsExec with a timeout, not
; ExecWait: a hung app must not hang the uninstaller.
;
; This has to be customRemoveFiles, not customUnInstall: electron-builder
; inserts customUnInstall after $INSTDIR is already deleted. Defining
; customRemoveFiles replaces electron-builder's own file removal, so the rest
; of the macro is that default block, unchanged, from
; app-builder-lib/templates/nsis/uninstaller.nsh (electron-builder 26.16.1,
; pinned exactly in package.json; test/installers.test.js compares the two).
!macro customRemoveFiles
  ${ifNot} ${isUpdated}
    DetailPrint "Removing Plexiform's hooks from your coding agents"
    ; $0 is kept; nsExec leaves the exit code (or "timeout") on the stack
    Push $0
    nsExec::Exec /TIMEOUT=30000 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-hooks'
    Pop $0
    Pop $0
  ${endIf}

  ; ---- electron-builder's default block from here ----
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      # Attempt to restore previous directory
      Push ""
      Call un.restoreFiles
      Pop $R0

      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}

  ${endif}

  # Move out of $INSTDIR so it can be removed
  SetOutPath $TEMP
  # Remove all files (or remaining shallow directories from the block above)
  RMDir /r $INSTDIR
!macroend
