; Tauri 2.11's built-in NSIS association macro writes the extension's default
; ProgID. Viewda registers only as an Open With handler so installation cannot
; replace the user's existing default application.
!define VIEWDA_PARQUET_PROGID "Viewda.Parquet"

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\${VIEWDA_PARQUET_PROGID}" "" "Apache Parquet file"
  WriteRegStr SHCTX "Software\Classes\${VIEWDA_PARQUET_PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${VIEWDA_PARQUET_PROGID}\shell" "" "open"
  WriteRegStr SHCTX "Software\Classes\${VIEWDA_PARQUET_PROGID}\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${VIEWDA_PARQUET_PROGID}\shell\open\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
  WriteRegStr SHCTX "Software\Classes\.parquet\OpenWithProgids" "${VIEWDA_PARQUET_PROGID}" ""
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue SHCTX "Software\Classes\.parquet\OpenWithProgids" "${VIEWDA_PARQUET_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\${VIEWDA_PARQUET_PROGID}"
  !insertmacro UPDATEFILEASSOC
!macroend
