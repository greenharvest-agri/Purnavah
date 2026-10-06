"""
menu.py — Purnavah Order Management
Run this from Pydroid on Android.
Same options as run_all.bat.
"""
import os
import sys
import subprocess

def clear():
    os.system('cls' if os.name == 'nt' else 'clear')

def run(cmd):
    subprocess.run(cmd, shell=True)

def menu():
    while True:
        clear()
        print("=" * 45)
        print("  PURNAVAH ORDER MANAGEMENT")
        print("=" * 45)
        print()
        print("  [1]  Parse new WhatsApp order")
        print("  [2]  Generate invoices — Google Sheets")
        print("  [3]  Generate invoices — local orders.xlsx")
        print("  [4]  Generate invoice — one customer (Sheets)")
        print("  [5]  Generate invoice — one customer (local)")
        print("  [6]  Update website from catalog.xlsx")
        print("  [7]  Exit")
        print()
        choice = input("  Choose (1-7): ").strip()

        if choice == "1":
            run("python parse_whatsapp.py")
            input("\nPress Enter to continue...")

        elif choice == "2":
            run("python generate_invoices.py --source sheets")
            input("\nPress Enter to continue...")

        elif choice == "3":
            run("python generate_invoices.py --source local")
            input("\nPress Enter to continue...")

        elif choice == "4":
            name = input("  Customer name exactly: ").strip()
            run(f'python generate_invoices.py --source sheets --customer "{name}"')
            input("\nPress Enter to continue...")

        elif choice == "5":
            name = input("  Customer name exactly: ").strip()
            run(f'python generate_invoices.py --source local --customer "{name}"')
            input("\nPress Enter to continue...")

        elif choice == "6":
            run("python ../build_form.py")
            input("\nPress Enter to continue...")

        elif choice == "7":
            print("\n  Goodbye!\n")
            sys.exit(0)

        else:
            print("  Invalid choice.")

if __name__ == "__main__":
    menu()
