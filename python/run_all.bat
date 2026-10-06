@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Purnavah Invoice Tools

:: --- Check Python is installed ---
where python >nul 2>nul
if errorlevel 1 (
    echo.
    echo ERROR: Python was not found on your PATH.
    echo Install Python 3.9+ from https://www.python.org/downloads/
    echo and make sure "Add python.exe to PATH" is checked during setup.
    echo.
    pause
    exit /b 1
)

:: --- Check required packages are installed ---
python -c "import pandas, openpyxl, reportlab, num2words, qrcode" >nul 2>nul
if errorlevel 1 (
    echo.
    echo Some required Python packages are missing ^(see requirements.txt^).
    set /p INSTALL_CHOICE="Install them now? (Y/N): "
    if /i "!INSTALL_CHOICE!"=="Y" (
        python -m pip install -r requirements.txt
    ) else (
        echo Skipping install - the options below may fail until packages are installed.
        pause
    )
)

:MENU
cls
echo ===================================================
echo   Purnavah Invoice Tools
echo ===================================================
echo   1. Parse WhatsApp order into orders.xlsx
echo   2. Generate ALL invoices
echo   3. Generate ONE customer's invoice
echo   4. Open orders.xlsx
echo   5. Open invoices folder
echo   6. Update website + template from catalog.xlsx
echo   7. Exit
echo ===================================================
set /p CHOICE="Select an option (1-7): "

if "%CHOICE%"=="1" goto PARSE
if "%CHOICE%"=="2" goto ALL
if "%CHOICE%"=="3" goto ONE
if "%CHOICE%"=="4" goto OPEN_ORDERS
if "%CHOICE%"=="5" goto OPEN_INVOICES
if "%CHOICE%"=="6" goto REBUILD
if "%CHOICE%"=="7" goto END
echo Invalid choice. Try again.
pause
goto MENU

:PARSE
python parse_whatsapp.py
pause
goto MENU

:ALL
cls
echo.
echo  Data source:
echo  [1] Local orders.xlsx
echo  [2] Google Sheets (live)
echo.
set /p SRC="Choose source (1 or 2): "
if "%SRC%"=="2" (
    python generate_invoices.py --source sheets
) else (
    python generate_invoices.py --source local
)
pause
goto MENU

:ONE
cls
echo.
echo  Data source:
echo  [1] Local orders.xlsx
echo  [2] Google Sheets (live)
echo.
set /p SRC="Choose source (1 or 2): "
set /p CUSTOMER="Enter customer name exactly as it appears in orders.xlsx: "
if "%SRC%"=="2" (
    python generate_invoices.py --source sheets --customer "%CUSTOMER%"
) else (
    python generate_invoices.py --source local --customer "%CUSTOMER%"
)
pause
goto MENU

:OPEN_ORDERS
if exist orders.xlsx (
    start "" "orders.xlsx"
) else (
    echo orders.xlsx not found. Copy orders_template.xlsx to orders.xlsx first.
    pause
)
goto MENU

:OPEN_INVOICES
if not exist invoices (
    mkdir invoices
)
start "" "invoices"
goto MENU

:REBUILD
cls
echo.
echo  Reading catalog.xlsx and updating index.html + orders_template.xlsx...
echo.
python ..\build_form.py
echo.
pause
goto MENU

:END
endlocal
exit /b 0
