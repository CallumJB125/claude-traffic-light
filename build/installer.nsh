; Plexiform uninstaller additions (wired in electron-builder.config.js, nsis.include).
;
; Before the app's files go, run it once with --uninstall-hooks so Claude
; Code, Cursor, Codex, Gemini and ~/.claude.json are not left with commands
; that point at a deleted exe. Not on an update (--updated): the new version
; is about to rewrite those commands itself. nsExec with a timeout, not
; ExecWait: nsExec bounds output inactivity.
;
; This has to be customRemoveFiles, not customUnInstall: electron-builder
; inserts customUnInstall after $INSTDIR is already deleted. Defining
; customRemoveFiles replaces electron-builder's own file removal, so the rest
; of the macro contains that default block, unchanged, from
; app-builder-lib/templates/nsis/uninstaller.nsh (electron-builder 26.16.1,
; pinned exactly in package.json; test/installers.test.js compares the two).
; Keep the waiting update installer outside the directory its child removes.
; The install section selects $INSTDIR again before extracting the new app.
!macro customInit
  SetOutPath $TEMP
!macroend

!macro customRemoveFiles
  ${ifNot} ${isUpdated}
    DetailPrint "Removing Plexiform's hooks from your coding agents"
    ; $0 is kept; nsExec leaves the exit code (or "timeout") on the stack
    Push $0
    nsExec::Exec /TIMEOUT=30000 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-hooks'
    Pop $0
    ${if} $0 != "0"
      DetailPrint "Hook removal failed: $0"
      Pop $0
      SetErrorLevel 1
      Abort "Unable to remove Plexiform's hooks; app files were kept."
    ${endIf}
    Pop $0
  ${endIf}

  ; The nsExec timeout is output inactivity, not a total process deadline.
  ; Only errors from the original removal block should reach its check below.
  ClearErrors
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
  ; ---- electron-builder's default block ends here ----

  IfErrors 0 plexiform_remove_files_no_error
    DetailPrint "Plexiform app files could not be fully removed"
    SetErrorLevel 1
    Abort "Plexiform removal was incomplete."
  plexiform_remove_files_no_error:
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 plexiform_remove_files_done
    DetailPrint "Plexiform's app executable remains after removal"
    SetErrorLevel 1
    Abort "Plexiform's app executable could not be removed."
  plexiform_remove_files_done:
!macroend
