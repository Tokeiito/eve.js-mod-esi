@echo off
setlocal
title EvEJS - ESI/SSO Replica Mod Tests

rem Runs the mod's unit tests with Node's built-in runner.

rem Vendor-drift tests read an eve.js checkout named by EVEJS_REPO_ROOT, and skip
rem without one. Pass --require-vendor to make that absence a failure.
if /i "%~1"=="--require-vendor" set "ESI_MOD_REQUIRE_VENDOR=1"

where node >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] Node.js is not installed or not on PATH.
  pause
  exit /b 1
)

if not defined EVEJS_REPO_ROOT (
  if defined ESI_MOD_REQUIRE_VENDOR (
    echo   [ERROR] --require-vendor needs EVEJS_REPO_ROOT set to an eve.js checkout.
    pause
    exit /b 2
  )
  echo   [NOTE] EVEJS_REPO_ROOT is not set, so vendor-drift tests skip.
  echo          Set it to an eve.js checkout to run them.
) else if not exist "%EVEJS_REPO_ROOT%\server\src" (
  if defined ESI_MOD_REQUIRE_VENDOR (
    echo   [NOTE] No eve.js tree at "%EVEJS_REPO_ROOT%", and --require-vendor was
    echo          asked for, so the run will FAIL rather than skip drift tests.
  ) else (
    echo   [NOTE] No eve.js tree at "%EVEJS_REPO_ROOT%": vendor-drift tests skip.
    echo          Set EVEJS_REPO_ROOT to an eve.js checkout to run them.
  )
)

rem The suite does not ship with the mod (D20), so it runs from this directory.
rem The quoted glob is required: a bare directory fails with MODULE_NOT_FOUND.
pushd "%~dp0"
node --test "test/**/*.test.js"
set "TEST_EXIT=%errorlevel%"
popd

if not "%TEST_EXIT%"=="0" (
  echo.
  echo   Tests failed with code %TEST_EXIT%.
  pause
)

exit /b %TEST_EXIT%
