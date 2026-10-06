@echo off
cd /d "%~dp0"
title Generate Invoices
python generate_invoices.py
if exist invoices (
    start "" "invoices"
) else (
    echo Invoices folder not found - check the output above for errors.
    pause
)
