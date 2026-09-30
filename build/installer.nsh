; Plexiform uninstaller additions (wired in electron-builder.config.js, nsis.include).
;
; Before the app's files go, run it once with --uninstall-hooks so Claude
; Code, Cursor, Codex, Gemini and ~/.claude.json are not left with commands
; that point at a deleted exe. Not on an update (--updated): the new version
; is about to rewrite those commands itself.
;
; This has to be customRemoveFiles, not customUnInstall: electron-builder
; inserts customUnInstall after $INSTDIR is already deleted. Defining
; customRemoveFiles replaces electron-builder's own file removal, so the rest
; of the macro is that default block, unchanged, from
; app-builder-lib/templates/nsis/uninstaller.nsh (electron-builder 25.1).
!macro customRemoveFiles
  ${ifNot} ${isUpdated}
    DetailPrint "Removing Plexiform's hooks from your coding agents"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-hooks'
  ${endIf}

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

  # Remove all files (or remaining shallow directories from the block above)
  RMDir /r $INSTDIR
!macroend
