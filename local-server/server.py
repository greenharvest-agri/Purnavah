#!/usr/bin/env python3
"""
Local stand-in for the Orders Apps Script Web App, just for developing
finance.html against before the Expenses feature is finalized and ported
into google-apps-script/orders_code.gs + redeployed for real.

Speaks the same ?action=... contract as the live Orders script:
  GET  ?action=list&key=...            -> orders   (mirrors doGet in orders_code.gs)
  GET  ?action=listCreditNotes&key=...  -> credit notes
  GET  ?action=listExpenses&key=...     -> expenses (new, local-only for now)
  POST {action:"addExpense", ...}       -> append an expense
  POST {action:"deleteExpense", id}     -> remove an expense

Once the Expenses tab/actions are added to orders_code.gs and redeployed,
finance.html only needs its "Script URL" field switched from
http://localhost:8787 to the real https://script.google.com/.../exec URL
— no other code changes.

Run:  python local-server/server.py
"""
import json
import os
import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

ADMIN_KEY = "purnavah-admin-2026"  # same default key finance.html ships with
PORT = 8787

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
ORDERS_FILE = os.path.join(DATA_DIR, "orders.json")
CREDIT_NOTES_FILE = os.path.join(DATA_DIR, "credit_notes.json")
EXPENSES_FILE = os.path.join(DATA_DIR, "expenses.json")

EXPENSE_CATEGORIES = [
    "Wholesale Purchase", "Packaging Material", "Packing Labor",
    "Shipping/Courier", "Personal Transport", "Other",
]

# Fictional test orders (never real customer data) — a spread across
# July/August 2026 so date-range filtering has something to show, including
# one Cancelled (must be excluded from revenue) and one not-yet-invoiced
# order (excluded because P&L revenue is recognized at invoice time, same
# as invoices.html's existing filterInvoices()).
SEED_ORDERS = [
    {"rowIndex": 2, "orderRef": "ORD-TEST-0001", "gaplOrderId": "GAPL-08/26-00001",
     "customerName": "Test Customer A", "status": "Invoiced", "orderTotal": 3200,
     "discountAmount": 160, "finalTotal": 3040, "invoiceNo": "INV-T-0001", "invoiceDate": "03/08/2026"},
    {"rowIndex": 3, "orderRef": "ORD-TEST-0002", "gaplOrderId": "GAPL-08/26-00002",
     "customerName": "Test Customer B", "status": "Delivered", "orderTotal": 5400,
     "discountAmount": 0, "finalTotal": 5400, "invoiceNo": "INV-T-0002", "invoiceDate": "05/08/2026"},
    {"rowIndex": 4, "orderRef": "ORD-TEST-0003", "gaplOrderId": "GAPL-08/26-00003",
     "customerName": "Test Customer C", "status": "Packed & Shipped", "orderTotal": 2100,
     "discountAmount": 100, "finalTotal": 2000, "invoiceNo": "INV-T-0003", "invoiceDate": "08/08/2026"},
    {"rowIndex": 5, "orderRef": "ORD-TEST-0004", "gaplOrderId": "GAPL-08/26-00004",
     "customerName": "Test Customer D", "status": "Confirmed", "orderTotal": 1800,
     "discountAmount": 0, "finalTotal": 1800, "invoiceNo": "", "invoiceDate": ""},
    {"rowIndex": 6, "orderRef": "ORD-TEST-0005", "gaplOrderId": "GAPL-08/26-00005",
     "customerName": "Test Customer E", "status": "Cancelled", "orderTotal": 900,
     "discountAmount": 0, "finalTotal": 900, "invoiceNo": "", "invoiceDate": ""},
    {"rowIndex": 7, "orderRef": "ORD-TEST-0006", "gaplOrderId": "GAPL-07/26-00010",
     "customerName": "Test Customer F", "status": "Invoiced", "orderTotal": 4200,
     "discountAmount": 200, "finalTotal": 4000, "invoiceNo": "INV-T-0004", "invoiceDate": "20/07/2026"},
    {"rowIndex": 8, "orderRef": "ORD-TEST-0007", "gaplOrderId": "GAPL-08/26-00006",
     "customerName": "Test Customer G", "status": "Delivered", "orderTotal": 6100,
     "discountAmount": 300, "finalTotal": 5800, "invoiceNo": "INV-T-0005", "invoiceDate": "12/08/2026"},
    {"rowIndex": 9, "orderRef": "ORD-TEST-0008", "gaplOrderId": "GAPL-08/26-00007",
     "customerName": "Test Customer H", "status": "Invoiced", "orderTotal": 2750,
     "discountAmount": 0, "finalTotal": 2750, "invoiceNo": "INV-T-0006", "invoiceDate": "14/08/2026"},
]

SEED_CREDIT_NOTES = [
    {"creditNoteNo": "CN-T-0001", "creditNoteDate": "10/08/2026", "invoiceNo": "INV-T-0002",
     "customerName": "Test Customer B", "totalAmount": 540, "reason": "1 damaged pack returned"},
    {"creditNoteNo": "CN-T-0002", "creditNoteDate": "22/07/2026", "invoiceNo": "INV-T-0004",
     "customerName": "Test Customer F", "totalAmount": 200, "reason": "Goodwill adjustment for delayed delivery"},
]

SEED_EXPENSES = [
    {"id": 1, "date": "02/08/2026", "category": "Wholesale Purchase", "description": "Bulk dals + rice from wholesaler",
     "amount": 12000, "paymentMode": "Bank Transfer", "notes": "", "loggedAt": "2026-08-02T10:00:00"},
    {"id": 2, "date": "04/08/2026", "category": "Packaging Material", "description": "Pouches + tape + boxes",
     "amount": 1500, "paymentMode": "Cash", "notes": "", "loggedAt": "2026-08-04T09:30:00"},
    {"id": 3, "date": "06/08/2026", "category": "Shipping/Courier", "description": "Courier charges — 5 orders",
     "amount": 950, "paymentMode": "UPI", "notes": "", "loggedAt": "2026-08-06T18:00:00"},
    {"id": 4, "date": "09/08/2026", "category": "Packing Labor", "description": "Packing help — 1 day",
     "amount": 500, "paymentMode": "Cash", "notes": "", "loggedAt": "2026-08-09T17:00:00"},
    {"id": 5, "date": "11/08/2026", "category": "Personal Transport", "description": "Fuel for pickup/drop to courier",
     "amount": 300, "paymentMode": "Cash", "notes": "", "loggedAt": "2026-08-11T20:00:00"},
]


def load_json(path, default):
    if not os.path.exists(path):
        save_json(path, default)
        return json.loads(json.dumps(default))  # deep copy
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send_json({})

    def do_GET(self):
        qs = parse_qs(urlparse(self.path).query)
        action = (qs.get("action") or [""])[0]
        key = (qs.get("key") or [""])[0]
        if key != ADMIN_KEY:
            self._send_json({"status": "error", "message": "Invalid admin key"})
            return
        if action == "list":
            self._send_json({"status": "ok", "data": load_json(ORDERS_FILE, SEED_ORDERS)})
        elif action == "listCreditNotes":
            self._send_json({"status": "ok", "data": load_json(CREDIT_NOTES_FILE, SEED_CREDIT_NOTES)})
        elif action == "listExpenses":
            self._send_json({"status": "ok", "data": load_json(EXPENSES_FILE, SEED_EXPENSES)})
        else:
            self._send_json({"status": "error", "message": "Unknown action: " + action})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            self._send_json({"status": "error", "message": "Invalid JSON body"})
            return
        if body.get("key") != ADMIN_KEY:
            self._send_json({"status": "error", "message": "Invalid admin key"})
            return
        action = body.get("action")
        if action == "addExpense":
            self._add_expense(body)
        elif action == "deleteExpense":
            self._delete_expense(body)
        else:
            self._send_json({"status": "error", "message": "Unknown action: " + str(action)})

    def _add_expense(self, body):
        category = body.get("category", "")
        if category not in EXPENSE_CATEGORIES:
            self._send_json({"status": "error", "message": "Unknown category: " + str(category)})
            return
        try:
            amount = float(body.get("amount"))
        except (TypeError, ValueError):
            self._send_json({"status": "error", "message": "Amount must be a number"})
            return
        if amount <= 0:
            self._send_json({"status": "error", "message": "Amount must be greater than 0"})
            return
        if not body.get("date"):
            self._send_json({"status": "error", "message": "Date is required"})
            return

        expenses = load_json(EXPENSES_FILE, SEED_EXPENSES)
        next_id = max((e["id"] for e in expenses), default=0) + 1
        entry = {
            "id": next_id,
            "date": body.get("date"),
            "category": category,
            "description": body.get("description", ""),
            "amount": amount,
            "paymentMode": body.get("paymentMode", ""),
            "notes": body.get("notes", ""),
            "loggedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        }
        expenses.append(entry)
        save_json(EXPENSES_FILE, expenses)
        self._send_json({"status": "ok", "expense": entry})

    def _delete_expense(self, body):
        try:
            target_id = int(body.get("id"))
        except (TypeError, ValueError):
            self._send_json({"status": "error", "message": "Invalid id"})
            return
        expenses = load_json(EXPENSES_FILE, SEED_EXPENSES)
        remaining = [e for e in expenses if e["id"] != target_id]
        if len(remaining) == len(expenses):
            self._send_json({"status": "error", "message": "Expense not found"})
            return
        save_json(EXPENSES_FILE, remaining)
        self._send_json({"status": "ok"})

    def log_message(self, format, *args):
        pass  # default per-request stderr logging is just noise for a local dev loop


def main():
    load_json(ORDERS_FILE, SEED_ORDERS)
    load_json(CREDIT_NOTES_FILE, SEED_CREDIT_NOTES)
    load_json(EXPENSES_FILE, SEED_EXPENSES)
    server = HTTPServer(("localhost", PORT), Handler)
    print(f"Local finance mock server running at http://localhost:{PORT}")
    print(f"Data stored in: {DATA_DIR}")
    print("Edit/delete those JSON files any time to reset or tweak test data.")
    server.serve_forever()


if __name__ == "__main__":
    main()
