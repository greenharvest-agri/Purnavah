"""
Purnavah / GAPL Invoice Generator (catalog-driven)

Reads orders from a flat Excel sheet (one row per customer, one column per
product) and customer records from a Zoho-style export, looks up product
rate/HSN/GST from catalog.xlsx via load_catalog.py, and writes one PDF
invoice per customer.

Usage (run from inside python/):
  python generate_invoices.py                              # auto-detect files in current dir
  python generate_invoices.py orders.xlsx                   # specify orders file
  python generate_invoices.py orders.xlsx customers.xlsx    # specify both
  python generate_invoices.py --orders o.xlsx --customers c.xlsx --logo logo.jpg
  python generate_invoices.py --customer "Test Customer 1"  # only one customer
  python generate_invoices.py --start 7 --out ./out         # start numbering from INV-000007
"""

import os
import re
import sys
import io
import argparse
from io import BytesIO
from pathlib import Path
from datetime import date, timedelta

import qrcode as _qrcode

# Force UTF-8 output on Windows so Rs and other Unicode chars print correctly
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
elif sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import pandas as pd
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable,
    Image as RLImage,
)
from reportlab.lib.enums import TA_RIGHT, TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from num2words import num2words

sys.path.insert(0, os.path.dirname(__file__))
from load_catalog import get_product_lookup, build_wa_product_map

# ── Register a Unicode-capable font (supports ₹ U+20B9) ──────────────────────
# Prefers Windows Calibri; falls back to DejaVu Sans on Linux (e.g. GitHub
# Actions) so PDFs still render correctly off Windows. Registered under the
# "Calibri" family name either way — nothing else in this file needs to change.
_WIN_FONT_DIR = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
_DEJAVU_DIR   = Path("/usr/share/fonts/truetype/dejavu")
_FONT_CANDIDATES = [
    (_WIN_FONT_DIR / "calibri.ttf",  _WIN_FONT_DIR / "calibrib.ttf",
     _WIN_FONT_DIR / "calibrii.ttf", _WIN_FONT_DIR / "calibriz.ttf"),
    (_DEJAVU_DIR / "DejaVuSans.ttf",       _DEJAVU_DIR / "DejaVuSans-Bold.ttf",
     _DEJAVU_DIR / "DejaVuSans-Oblique.ttf", _DEJAVU_DIR / "DejaVuSans-BoldOblique.ttf"),
]
for _reg, _bold, _italic, _bolditalic in _FONT_CANDIDATES:
    if _reg.exists():
        break
else:
    raise FileNotFoundError(
        "No Unicode-capable TTF font found (looked for Calibri under "
        f"{_WIN_FONT_DIR} and DejaVu Sans under {_DEJAVU_DIR}). "
        "Install one (on Debian/Ubuntu: apt-get install fonts-dejavu-core)."
    )
pdfmetrics.registerFont(TTFont("Calibri",            _reg))
pdfmetrics.registerFont(TTFont("Calibri-Bold",       _bold))
pdfmetrics.registerFont(TTFont("Calibri-Italic",     _italic))
pdfmetrics.registerFont(TTFont("Calibri-BoldItalic", _bolditalic))
pdfmetrics.registerFontFamily(
    "Calibri",
    normal="Calibri",
    bold="Calibri-Bold",
    italic="Calibri-Italic",
    boldItalic="Calibri-BoldItalic",
)

# ─────────────────────────────────────────────────────────────────────────────
# COMPANY CONFIG  (edit these — they don't change run-to-run)
# ─────────────────────────────────────────────────────────────────────────────
COMPANY_NAME       = "Greenharvest Agriculture Private Limited"
COMPANY_ADDRESS_1  = "Plot 122/3, Anjani, Gaurela-Pendra-Marwahi, Chhattisgarh - 495117"
COMPANY_GSTIN      = "22AALCG0905G1Z1"
COMPANY_STATE_CODE = "22"
COMPANY_STATE      = "Chhattisgarh"
COMPANY_EMAIL      = "priyam.jaiswal@globalgreenharvest.com"
COMPANY_WEBSITE    = "www.purnavah.com"

# ─────────────────────────────────────────────────────────────────────────────
# UPI PAYMENT CONFIG
# ─────────────────────────────────────────────────────────────────────────────
UPI_ID    = "priyam1602@okaxis"
UPI_PAYEE = "Greenharvest Agriculture"

# ─────────────────────────────────────────────────────────────────────────────
# INVOICE CONFIG
# ─────────────────────────────────────────────────────────────────────────────
DISCOUNT_PERCENT  = 0       # % discount applied on subtotal before tax (0 = none)
INVOICE_DUE_DAYS  = 15      # Net payment terms
INVOICE_DATE      = date.today()

# ─────────────────────────────────────────────────────────────────────────────
# CUSTOMER NAME MAPPING
# Add entries here when an Orders-sheet name doesn't match the customer master.
# ─────────────────────────────────────────────────────────────────────────────
NAME_MAPPING = {}

# ─────────────────────────────────────────────────────────────────────────────
# GOOGLE SHEETS ORDERS SOURCE  (used with --source sheets)
# The sheet is the one index.html's WhatsApp-order webhook logs to — product
# columns are expected to be WA Keys ("Display Name (Pack Size)"), same as
# catalog.xlsx's WA Key column.
# ─────────────────────────────────────────────────────────────────────────────
SHEET_ID          = os.environ.get("SHEET_ID", "REPLACE_WITH_YOUR_SHEET_ID")
SHEET_NAME_ORDERS = "Orders"

# Runtime logo path — set by main() from CLI arg or auto-detection
LOGO_PATH = ""

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT  = SCRIPT_DIR.parent

# ─────────────────────────────────────────────────────────────────────────────
# INDIAN STATE CODE MAPS
# ─────────────────────────────────────────────────────────────────────────────
_ABBR_TO_CODE = {
    "AN": "35", "AP": "28", "AR": "12", "AS": "18", "BR": "10",
    "CG": "22", "CH": "04", "DD": "26", "DL": "07", "GA": "30",
    "GJ": "24", "HR": "06", "HP": "02", "JH": "20", "JK": "01",
    "KA": "29", "KL": "32", "LA": "38", "LD": "31", "MH": "27",
    "MN": "14", "ML": "17", "MP": "23", "MZ": "15", "NL": "13",
    "OD": "21", "PB": "03", "PY": "34", "RJ": "08", "SK": "11",
    "TG": "36", "TN": "33", "TR": "16", "UK": "05", "UP": "09",
    "WB": "19",
}
_NAME_TO_CODE = {
    "andaman and nicobar islands": "35", "andhra pradesh": "28",
    "arunachal pradesh": "12", "assam": "18", "bihar": "10",
    "chhattisgarh": "22", "chandigarh": "04",
    "dadra and nagar haveli and daman and diu": "26",
    "dadra and nagar haveli": "26", "daman and diu": "26",
    "delhi": "07", "goa": "30", "gujarat": "24", "haryana": "06",
    "himachal pradesh": "02", "jharkhand": "20",
    "jammu and kashmir": "01", "karnataka": "29", "kerala": "32",
    "ladakh": "38", "lakshadweep": "31", "maharashtra": "27",
    "manipur": "14", "meghalaya": "17", "madhya pradesh": "23",
    "mizoram": "15", "nagaland": "13", "odisha": "21", "punjab": "03",
    "puducherry": "34", "pondicherry": "34", "rajasthan": "08",
    "sikkim": "11", "telangana": "36", "tamil nadu": "33",
    "tripura": "16", "uttarakhand": "05", "uttar pradesh": "09",
    "west bengal": "19",
}

# Orders-sheet columns that are metadata, not products
META_COLS = {"Customer Name", "Phone", "Pincode", "Address", "Notes", "Order Date"}

# ─────────────────────────────────────────────────────────────────────────────
# COLOURS & LAYOUT
# ─────────────────────────────────────────────────────────────────────────────
C_DARK      = colors.HexColor("#1A3C34")
C_MID       = colors.HexColor("#2E7D52")
C_ALT_ROW   = colors.HexColor("#EAF4EE")
C_TOTALS_BG = colors.HexColor("#F0FAF4")
C_BAL_BG    = colors.HexColor("#D4EDDA")
C_BORDER    = colors.HexColor("#CCCCCC")
C_MUTED     = colors.HexColor("#666666")
C_BODY      = colors.HexColor("#1C1C1C")

PAGE_W, PAGE_H = A4
MARGIN = 14 * mm


# ─────────────────────────────────────────────────────────────────────────────
# UTILITY
# ─────────────────────────────────────────────────────────────────────────────

def clean(val, fallback=""):
    s = str(val).strip()
    return fallback if s in ("nan", "None", "NaN", "") else s


def fmt_inr(amount):
    return f"₹{amount:,.2f}"


def amount_to_words(amount):
    amount = round(amount, 2)
    rupees = int(amount)
    paise  = round((amount - rupees) * 100)
    try:
        r_words = num2words(rupees, lang="en_IN").title()
    except Exception:
        r_words = num2words(rupees).title()
    result = f"Indian Rupee {r_words}"
    if paise:
        try:
            p_words = num2words(paise, lang="en_IN").title()
        except Exception:
            p_words = num2words(paise).title()
        result += f" And {p_words} Paise"
    return result + " Only"


def inv_number(n):
    return f"INV-{n:06d}"


def ps(name, **kw):
    return ParagraphStyle(name, **kw)


def get_state_code(gstin, place_of_contact, billing_state):
    g = clean(gstin)
    if g and len(g) >= 2 and g[:2].isdigit():
        return g[:2]
    poc = clean(place_of_contact).upper()
    if poc in _ABBR_TO_CODE:
        return _ABBR_TO_CODE[poc]
    return _NAME_TO_CODE.get(billing_state.lower().strip(), "00")


def find_col(df, *keywords):
    """Return first column name containing any keyword (case-insensitive)."""
    for c in df.columns:
        cl = str(c).lower()
        if any(k.lower() in cl for k in keywords):
            return c
    return None


def find_sheet(sheet_names, *keywords):
    """Return first sheet whose name contains any keyword (case-insensitive)."""
    for s in sheet_names:
        sl = s.lower()
        if any(k.lower() in sl for k in keywords):
            return s
    return None


# ─────────────────────────────────────────────────────────────────────────────
# FILE AUTO-DISCOVERY
# ─────────────────────────────────────────────────────────────────────────────

def find_logo(near_path):
    """Look for a logo image: alongside the orders file, then CWD, then repo root/Artifacts."""
    dirs = [Path(near_path).parent, Path.cwd(), SCRIPT_DIR, REPO_ROOT, REPO_ROOT / "Artifacts"]
    for d in dirs:
        if not d.exists():
            continue
        for pat in ["*logo*.[jp][pn][g]*", "*logo*.[jJ][pP][eE][gG]",
                    "*GAPL*.[jp][pn][g]*", "*GAPL*.[jJ][pP][eE][gG]",
                    "*purnavah*.[jp][pn][g]*"]:
            hits = list(d.glob(pat))
            if hits:
                return str(hits[0])
    return ""


def find_customers_file(near_path):
    """Look for a customers Excel: alongside the orders file, then CWD, then repo root/Artifacts."""
    dirs = [Path(near_path).parent, Path.cwd(), SCRIPT_DIR, REPO_ROOT / "Artifacts"]
    for d in dirs:
        if not d.exists():
            continue
        for pat in ["*customer*.[xX][lL][sS][xX]", "*crm*.[xX][lL][sS][xX]",
                    "*contact*.[xX][lL][sS][xX]", "*client*.[xX][lL][sS][xX]"]:
            hits = list(d.glob(pat))
            if hits:
                return str(hits[0])
    return ""


def detect_customers_sheet(customers_file):
    """Return the most likely sheet in a customers Excel file."""
    xf = pd.ExcelFile(customers_file)
    sheets = xf.sheet_names
    return (find_sheet(sheets, "sample", "data", "customer", "contact", "client")
            or sheets[0])


# ─────────────────────────────────────────────────────────────────────────────
# DATA LOADING
# ─────────────────────────────────────────────────────────────────────────────

def to_products_dict(catalog_lookup):
    """Adapt load_catalog's product dicts (mrp/gst_pct) to build_items's expected keys (rate/gst)."""
    products = {}
    for name, info in catalog_lookup.items():
        products[name] = {
            "hsn":  str(info.get("hsn", "") or ""),
            "unit": str(info.get("unit", "") or "Nos"),
            "rate": float(info.get("mrp", 0) or 0),
            "gst":  float(info.get("gst_pct", 0) or 0),
        }
    return products


def load_orders_flat(orders_file, sheet_name="Orders"):
    """
    Load orders from a flat Excel sheet: one row per order, columns =
    [Customer Name, Phone, Pincode, Address, Notes, Order Date, <product columns>...].
    Returns a list of order dicts (one per non-empty row), preserving duplicate
    customer names as separate orders.
    """
    df = pd.read_excel(orders_file, sheet_name=sheet_name, dtype=str)
    df.columns = df.columns.str.strip()
    product_cols = [c for c in df.columns if c not in META_COLS]

    orders = []
    for _, row in df.iterrows():
        name = clean(row.get("Customer Name", ""))
        if not name:
            continue
        qty_map = {}
        for pcol in product_cols:
            raw = clean(row.get(pcol, ""))
            if not raw:
                continue
            try:
                qty = float(raw)
            except ValueError:
                continue
            if qty > 0:
                qty_map[pcol] = qty
        if not qty_map:
            continue
        orders.append({
            "customer_name": name,
            "qty_map":       qty_map,
            "phone":         clean(row.get("Phone", "")),
            "pincode":       clean(row.get("Pincode", "")),
            "address":       clean(row.get("Address", "")),
            "notes":         clean(row.get("Notes", "")),
            "order_date":    clean(row.get("Order Date", "")),
        })
    return orders


def read_orders_from_sheets():
    """
    Read orders from the Google Sheet that index.html's WhatsApp-order webhook
    logs to, via the public CSV export endpoint. Returns a list of order dicts
    in the same shape as load_orders_flat(), or None if the sheet can't be
    read — callers should fall back to the local orders.xlsx in that case.
    """
    url = (
        f"https://docs.google.com/spreadsheets/d/{SHEET_ID}"
        f"/gviz/tq?tqx=out:csv&sheet={SHEET_NAME_ORDERS}"
    )
    print("Reading orders from Google Sheets...")
    try:
        df = pd.read_csv(url, dtype=str)
    except Exception as e:
        print(f"  Could not read Google Sheets: {e}")
        print("  Falling back to local orders.xlsx...")
        return None

    df.columns = [str(c).strip() for c in df.columns]

    c_name    = find_col(df, "customer name", "name")
    c_phone   = find_col(df, "phone")
    c_pincode = find_col(df, "pincode", "postal", "zip")
    c_state   = find_col(df, "state")
    c_address = find_col(df, "address")
    c_notes   = find_col(df, "notes")
    c_date    = find_col(df, "timestamp", "order date", "date")

    meta_cols = {c for c in (c_name, c_phone, c_pincode, c_state, c_address, c_notes, c_date) if c}
    meta_cols |= {col for col in df.columns if col.lower() in ("order total", "total")}

    wa_to_product = build_wa_product_map()

    orders = []
    unmatched = set()
    for _, row in df.iterrows():
        name = clean(row.get(c_name, "")) if c_name else ""
        if not name:
            continue
        qty_map = {}
        for wa_key in df.columns:
            if wa_key in meta_cols:
                continue
            raw = clean(row.get(wa_key, ""))
            if not raw:
                continue
            try:
                qty = float(raw)
            except ValueError:
                continue
            if qty <= 0:
                continue
            pname = wa_to_product.get(wa_key.strip())
            if not pname:
                unmatched.add(wa_key)
                continue
            qty_map[pname] = qty_map.get(pname, 0) + qty
        if not qty_map:
            continue
        orders.append({
            "customer_name": name,
            "qty_map":       qty_map,
            "phone":         clean(row.get(c_phone, "")) if c_phone else "",
            "pincode":       clean(row.get(c_pincode, "")) if c_pincode else "",
            "state":         clean(row.get(c_state, "")) if c_state else "",
            "address":       clean(row.get(c_address, "")) if c_address else "",
            "notes":         clean(row.get(c_notes, "")) if c_notes else "",
            "order_date":    clean(row.get(c_date, "")) if c_date else "",
        })

    if unmatched:
        print(f"  WARNING: {len(unmatched)} column(s) didn't match any WA Key in catalog.xlsx: "
              f"{', '.join(sorted(unmatched))}")
    print(f"  {len(orders)} orders loaded from Google Sheets")
    return orders


def customer_from_order(order):
    """
    Build a minimal customer record directly from a Sheets order's own
    delivery fields (name, phone, address, pincode, state) — there's no
    separate customer master for retail/WhatsApp orders, the order row
    already fully describes the customer. GSTIN is intentionally omitted.
    """
    name  = order["customer_name"]
    state = order.get("state", "")
    return {
        "name":       name,
        "first_name": name.split()[0] if name else "",
        "email":      "",
        "mobile":     order.get("phone", ""),
        "bill_addr1": order.get("address", ""),
        "bill_addr2": "",
        "bill_city":  "",
        "bill_state": state,
        "bill_pin":   order.get("pincode", ""),
        "ship_addr1": order.get("address", ""),
        "ship_addr2": "",
        "ship_city":  "",
        "ship_state": state,
        "ship_pin":   order.get("pincode", ""),
        "gstin":      "",
        "state_code": get_state_code("", state, state),
    }


def load_customers(customers_file, sheet_name):
    """
    Load customer records from a Zoho-style export or compatible format.
    Auto-detects column names by keyword matching.
    """
    df = pd.read_excel(customers_file, sheet_name=sheet_name, dtype=str)
    df.columns = df.columns.str.strip()

    def col(*candidates):
        for c in candidates:
            if c in df.columns:
                return c
        return find_col(df, *[c.lower().split()[0] for c in candidates])

    c_name   = col("Display Name", "Customer Name", "Name", "Full Name")
    c_fname  = col("First Name", "firstname")
    c_email  = col("EmailID", "Email", "Email Address", "email")
    c_mobile = col("MobilePhone", "Mobile", "Phone", "Contact")
    c_baddr1 = col("Billing Address", "Address Line 1", "Address", "Street")
    c_baddr2 = col("Billing Street2", "Address Line 2", "Street2")
    c_bcity  = col("Billing City", "City")
    c_bstate = col("Billing State", "State")
    c_bpin   = col("Billing Code", "Pincode", "Postal Code", "Zip")
    c_saddr1 = col("Shipping Address")
    c_saddr2 = col("Shipping Street2")
    c_scity  = col("Shipping City")
    c_sstate = col("Shipping State")
    c_spin   = col("Shipping Code")
    c_gstin  = col("GST Identification Number (GSTIN)", "GSTIN", "GST Number")
    c_poc    = col("Place of Contact", "State Code", "State Abbreviation")
    c_status = col("Status")

    def g(row, c):
        return clean(row.get(c, "")) if c else ""

    customers = {}
    for _, row in df.iterrows():
        disp = g(row, c_name)
        if not disp:
            continue
        if g(row, c_status).lower() == "inactive":
            continue

        bill_state = g(row, c_bstate)
        ship_state = g(row, c_sstate) or bill_state

        gstin      = g(row, c_gstin)
        poc        = g(row, c_poc)
        state_code = get_state_code(gstin, poc, bill_state)

        customers[disp] = {
            "name":       disp,
            "first_name": g(row, c_fname) or disp.split()[0],
            "email":      g(row, c_email),
            "mobile":     g(row, c_mobile),
            "bill_addr1": g(row, c_baddr1),
            "bill_addr2": g(row, c_baddr2),
            "bill_city":  g(row, c_bcity),
            "bill_state": bill_state,
            "bill_pin":   g(row, c_bpin),
            "ship_addr1": g(row, c_saddr1) or g(row, c_baddr1),
            "ship_addr2": g(row, c_saddr2) or g(row, c_baddr2),
            "ship_city":  g(row, c_scity)  or g(row, c_bcity),
            "ship_state": ship_state,
            "ship_pin":   g(row, c_spin)   or g(row, c_bpin),
            "gstin":      gstin,
            "state_code": state_code,
        }
    return customers


def find_customer(order_name, customers):
    """Match order-row name → customer record. NAME_MAPPING takes priority."""
    mapped = NAME_MAPPING.get(order_name)
    if mapped and mapped in customers:
        return customers[mapped]
    if order_name in customers:
        return customers[order_name]
    o_low = order_name.lower().strip()
    for k, v in customers.items():
        if k.lower().strip() == o_low:
            return v
    for k, v in customers.items():
        kl = k.lower().strip()
        if kl.startswith(o_low) or o_low.startswith(kl):
            return v
    first_word = o_low.split()[0]
    for k, v in customers.items():
        if v.get("first_name", "").lower() == first_word:
            return v
    return None


# ─────────────────────────────────────────────────────────────────────────────
# BUSINESS LOGIC
# ─────────────────────────────────────────────────────────────────────────────

def build_items(order_qty_map, products):
    """Build line items from {product_name: qty} dict."""
    items    = []
    subtotal = 0.0
    for pname, qty in order_qty_map.items():
        if pname not in products:
            print(f"    WARNING: '{pname}' not in catalog.xlsx - skipped.")
            continue
        p    = products[pname]
        line = round(qty * p["rate"], 2)
        subtotal += line
        items.append({
            "name":     pname,
            "hsn":      p["hsn"],
            "unit":     p["unit"],
            "qty":      qty,
            "rate":     p["rate"],
            "gst":      p["gst"],
            "line_amt": line,
            "is_free":  False,
        })
    return items, round(subtotal, 2)


def apply_tax(items, subtotal, state_code):
    """Attach per-item tax and return totals dict."""
    disc_amt  = round(subtotal * DISCOUNT_PERCENT / 100, 2)
    taxable   = round(subtotal - disc_amt, 2)
    disc_r    = disc_amt / subtotal if subtotal else 0

    is_intra  = (str(state_code).strip() == str(COMPANY_STATE_CODE).strip())
    cgst_tot  = sgst_tot = igst_tot = 0.0

    for it in items:
        it["taxable"] = round(it["line_amt"] * (1 - disc_r), 2)
        if is_intra:
            it["cgst_pct"]  = it["gst"] / 2
            it["sgst_pct"]  = it["gst"] / 2
            it["igst_pct"]  = 0.0
            it["cgst_amt"]  = round(it["taxable"] * it["cgst_pct"] / 100, 2)
            it["sgst_amt"]  = round(it["taxable"] * it["sgst_pct"] / 100, 2)
            it["igst_amt"]  = 0.0
            cgst_tot       += it["cgst_amt"]
            sgst_tot       += it["sgst_amt"]
        else:
            it["cgst_pct"]  = it["sgst_pct"] = 0.0
            it["igst_pct"]  = it["gst"]
            it["cgst_amt"]  = it["sgst_amt"] = 0.0
            it["igst_amt"]  = round(it["taxable"] * it["igst_pct"] / 100, 2)
            igst_tot       += it["igst_amt"]
        it["tax_amt"] = it["cgst_amt"] + it["sgst_amt"] + it["igst_amt"]
        it["final"]   = round(it["taxable"] + it["tax_amt"], 2)

    cgst_tot  = round(cgst_tot, 2)
    sgst_tot  = round(sgst_tot, 2)
    igst_tot  = round(igst_tot, 2)
    total_tax = round(cgst_tot + sgst_tot + igst_tot, 2)
    grand     = round(taxable + total_tax, 2)

    return items, {
        "subtotal":    subtotal,
        "disc_pct":    DISCOUNT_PERCENT,
        "disc_amt":    disc_amt,
        "taxable":     taxable,
        "is_intra":    is_intra,
        "cgst":        cgst_tot,
        "sgst":        sgst_tot,
        "igst":        igst_tot,
        "total_tax":   total_tax,
        "grand_total": grand,
    }


# ─────────────────────────────────────────────────────────────────────────────
# UPI QR CODE GENERATOR
# ─────────────────────────────────────────────────────────────────────────────

def make_upi_url(amount, inv_num, customer_name):
    """Return the UPI deep-link URL for the given invoice."""
    first = customer_name.split()[0]
    note  = f"{first} {inv_num}"[:50]
    return (
        "upi://pay"
        f"?pa={UPI_ID}"
        f"&pn={UPI_PAYEE.replace(' ', '+')}"
        f"&am={amount:.2f}"
        "&cu=INR"
        f"&tn={note.replace(' ', '+')}"
    )


def make_upi_qr_bytes(upi_url):
    """Render a UPI URL as a dark-green PNG QR code in a BytesIO buffer."""
    qr = _qrcode.QRCode(
        version=None,
        error_correction=_qrcode.constants.ERROR_CORRECT_M,
        box_size=5,
        border=2,
    )
    qr.add_data(upi_url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#1A3C34", back_color="white")
    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf


class LinkedImage(RLImage):
    """An Image flowable that is also a clickable link over its full area."""

    def __init__(self, *args, link_url=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.link_url = link_url

    def draw(self):
        super().draw()
        if self.link_url:
            self.canv.linkURL(
                self.link_url,
                (0, 0, self.drawWidth, self.drawHeight),
                relative=1,
                thickness=0,
            )


# ─────────────────────────────────────────────────────────────────────────────
# PDF STYLES
# ─────────────────────────────────────────────────────────────────────────────

def make_styles():
    return {
        "title":     ps("title",    fontSize=22, fontName="Calibri-Bold",
                        textColor=C_DARK, leading=28),
        "inv_ref":   ps("inv_ref",  fontSize=9,  fontName="Calibri",
                        textColor=C_MUTED, leading=13),
        "bal_lbl":   ps("bal_lbl",  fontSize=9,  fontName="Calibri-Bold",
                        textColor=C_MUTED),
        "bal_amt":   ps("bal_amt",  fontSize=18, fontName="Calibri-Bold",
                        textColor=C_DARK),
        "co_name":   ps("co_name",  fontSize=10, fontName="Calibri-Bold",
                        textColor=C_DARK,  alignment=TA_RIGHT),
        "co_det":    ps("co_det",   fontSize=8,  fontName="Calibri",
                        textColor=C_MUTED, alignment=TA_RIGHT, leading=12),
        "sec_lbl":   ps("sec_lbl",  fontSize=7,  fontName="Calibri-Bold",
                        textColor=C_MUTED, spaceAfter=2),
        "addr":      ps("addr",     fontSize=8.5, fontName="Calibri",
                        textColor=C_BODY, leading=13),
        "meta_lbl":  ps("meta_lbl", fontSize=7.5, fontName="Calibri-Bold",
                        textColor=C_MUTED),
        "meta_val":  ps("meta_val", fontSize=8.5, fontName="Calibri",
                        textColor=C_BODY),
        "pos":       ps("pos",      fontSize=9,  fontName="Calibri-Italic",
                        textColor=C_DARK),
        "th":        ps("th",       fontSize=8.5, fontName="Calibri-Bold",
                        textColor=colors.white, alignment=TA_CENTER),
        "td":        ps("td",       fontSize=8,  fontName="Calibri",
                        textColor=C_BODY),
        "td_r":      ps("td_r",     fontSize=8,  fontName="Calibri",
                        textColor=C_BODY, alignment=TA_RIGHT),
        "td_c":      ps("td_c",     fontSize=8,  fontName="Calibri",
                        textColor=C_BODY, alignment=TA_CENTER),
        "tl":        ps("tl",       fontSize=9,  fontName="Calibri",
                        textColor=C_BODY),
        "tl_b":      ps("tl_b",     fontSize=10, fontName="Calibri-Bold",
                        textColor=C_DARK),
        "tv":        ps("tv",       fontSize=9,  fontName="Calibri",
                        textColor=C_BODY, alignment=TA_RIGHT),
        "tv_b":      ps("tv_b",     fontSize=10, fontName="Calibri-Bold",
                        textColor=C_DARK, alignment=TA_RIGHT),
        "words":     ps("words",    fontSize=9,  fontName="Calibri-BoldItalic",
                        textColor=C_DARK),
        "note_hdr":  ps("note_hdr", fontSize=9,  fontName="Calibri-Bold",
                        textColor=C_DARK),
        "note_body": ps("note_body",fontSize=8.5, fontName="Calibri",
                        textColor=C_MUTED, leading=13),
        "sig":       ps("sig",      fontSize=8,  fontName="Calibri",
                        textColor=C_MUTED, alignment=TA_RIGHT),
        "qr_label":  ps("qr_label", fontSize=8,  fontName="Calibri-Bold",
                        textColor=C_DARK),
        "qr_sub":    ps("qr_sub",   fontSize=6.5, fontName="Calibri",
                        textColor=C_MUTED, leading=10),
        "upi_link":  ps("upi_link", fontSize=7.5, fontName="Calibri-Bold",
                        textColor=colors.HexColor("#1155CC"), leading=11),
    }


# ─────────────────────────────────────────────────────────────────────────────
# PDF BUILDER
# ─────────────────────────────────────────────────────────────────────────────

class InvoicePDF:
    def __init__(self, path, inv_num, customer, items, totals):
        self.path     = path
        self.inv_num  = inv_num
        self.customer = customer
        self.items    = items
        self.totals   = totals
        self.st       = make_styles()
        self.story    = []
        self.aw       = PAGE_W - 2 * MARGIN   # available width
        self.qr_buf   = None                   # populated in build()

    def build(self):
        self.upi_url = make_upi_url(
            self.totals["grand_total"],
            self.inv_num,
            self.customer["name"],
        )
        self.qr_buf = make_upi_qr_bytes(self.upi_url)
        doc = SimpleDocTemplate(
            self.path, pagesize=A4,
            leftMargin=MARGIN, rightMargin=MARGIN,
            topMargin=MARGIN,  bottomMargin=MARGIN,
        )
        self._section_header()
        self._section_meta()
        self._section_pos()
        self._section_items()
        self._section_totals()
        self._section_words()
        self._section_notes()
        self._section_signature()
        doc.build(self.story,
                  onFirstPage=self._draw_logo,
                  onLaterPages=self._draw_logo)

    # ── canvas ──────────────────────────────────────────────────────────────

    def _draw_logo(self, c, doc):
        c.saveState()
        lw, lh = 38 * mm, 20 * mm
        lx = PAGE_W - MARGIN - lw
        ly = PAGE_H - MARGIN - lh
        if LOGO_PATH and os.path.exists(LOGO_PATH):
            try:
                c.drawImage(LOGO_PATH, lx, ly, width=lw, height=lh,
                            preserveAspectRatio=True, mask="auto")
            except Exception:
                self._placeholder_logo(c, lx, ly, lw, lh)
        else:
            self._placeholder_logo(c, lx, ly, lw, lh)
        c.restoreState()

    @staticmethod
    def _placeholder_logo(c, x, y, w, h):
        c.setFillColor(C_MID)
        c.roundRect(x, y, w, h, 3 * mm, fill=1, stroke=0)
        c.setFillColor(colors.white)
        c.setFont("Calibri-Bold", 10)
        c.drawCentredString(x + w / 2, y + h / 2 + 3, "Purnavah")
        c.setFont("Calibri", 6.5)
        c.drawCentredString(x + w / 2, y + h / 2 - 5, "Greenharvest Agri")

    # ── helpers ──────────────────────────────────────────────────────────────

    def _p(self, text, s):
        return Paragraph(str(text), self.st[s])

    def _tbl(self, data, cw, cmds):
        t = Table(data, colWidths=cw)
        t.setStyle(TableStyle(cmds))
        return t

    def _hr(self, sb=0, sa=4):
        return HRFlowable(width="100%", thickness=0.4, color=C_BORDER,
                          spaceBefore=sb * mm, spaceAfter=sa * mm)

    # ── story sections ───────────────────────────────────────────────────────

    def _section_header(self):
        t = self.totals
        inv_d = INVOICE_DATE.strftime("%d %b %Y")
        due_d = (INVOICE_DATE + timedelta(days=INVOICE_DUE_DAYS)).strftime("%d %b %Y")

        left = [
            self._p("TAX INVOICE", "title"),
            Spacer(1, 2 * mm),
            self._p(f"Invoice #  {self.inv_num}", "inv_ref"),
            self._p(f"Date: {inv_d}  |  Due: {due_d}", "inv_ref"),
            Spacer(1, 5 * mm),
            self._p("Balance Due", "bal_lbl"),
            self._p(fmt_inr(t["grand_total"]), "bal_amt"),
        ]
        right = [
            Spacer(1, 22 * mm),   # headroom for logo drawn on canvas
            self._p(COMPANY_NAME, "co_name"),
            self._p(COMPANY_ADDRESS_1, "co_det"),
            self._p(f"GSTIN: {COMPANY_GSTIN}", "co_det"),
            self._p(f"Email: {COMPANY_EMAIL}", "co_det"),
            self._p(f"Web: {COMPANY_WEBSITE}", "co_det"),
        ]
        half = self.aw / 2
        self.story.append(self._tbl(
            [[left, right]], [half, half],
            [("VALIGN", (0, 0), (-1, -1), "TOP"),
             ("LEFTPADDING",   (0, 0), (-1, -1), 0),
             ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
             ("TOPPADDING",    (0, 0), (-1, -1), 0),
             ("BOTTOMPADDING", (0, 0), (-1, -1), 0)],
        ))
        self.story.append(self._hr(sb=3, sa=4))

    def _section_meta(self):
        c   = self.customer
        inv_d = INVOICE_DATE.strftime("%d %b %Y")
        due_d = (INVOICE_DATE + timedelta(days=INVOICE_DUE_DAYS)).strftime("%d %b %Y")

        def addr_block(label, name, *lines):
            block = [self._p(label, "sec_lbl"),
                     self._p(f"<b>{name}</b>", "addr")]
            for ln in lines:
                s = clean(ln)
                if s:
                    block.append(self._p(s, "addr"))
            return block

        b_city_pin = " - ".join(x for x in [c["bill_city"], c["bill_pin"]] if x)
        s_city_pin = " - ".join(x for x in [c["ship_city"], c["ship_pin"]] if x)

        bill = addr_block(
            "BILL TO", c["name"],
            c["bill_addr1"], c["bill_addr2"], b_city_pin, c["bill_state"],
            f"GSTIN: {c['gstin']}" if c["gstin"] else "",
        )
        ship = addr_block(
            "SHIP TO", c["name"],
            c["ship_addr1"], c["ship_addr2"], s_city_pin, c["ship_state"],
        )
        meta = [
            self._p("Invoice Date",   "meta_lbl"), self._p(inv_d,                  "meta_val"),
            Spacer(1, 2 * mm),
            self._p("Payment Terms",  "meta_lbl"), self._p(f"Net {INVOICE_DUE_DAYS}", "meta_val"),
            Spacer(1, 2 * mm),
            self._p("Due Date",       "meta_lbl"), self._p(due_d,                  "meta_val"),
        ]
        cw = self.aw / 3
        self.story.append(self._tbl(
            [[meta, bill, ship]], [cw, cw, cw],
            [("VALIGN", (0, 0), (-1, -1), "TOP"),
             ("LEFTPADDING",   (0, 0), (-1, -1), 2),
             ("RIGHTPADDING",  (0, 0), (-1, -1), 2),
             ("TOPPADDING",    (0, 0), (-1, -1), 0),
             ("BOTTOMPADDING", (0, 0), (-1, -1), 0)],
        ))
        self.story.append(Spacer(1, 4 * mm))

    def _section_pos(self):
        c = self.customer
        self.story.append(
            self._p(f"Place Of Supply: {c['bill_state']} ({c['state_code']})", "pos")
        )
        self.story.append(Spacer(1, 3 * mm))

    def _section_items(self):
        is_intra = self.totals["is_intra"]
        if is_intra:
            hdrs = ["#", "Item & Description", "HSN/SAC", "Qty",
                    "Rate", "CGST %", "CGST Amt", "SGST %", "SGST Amt", "Amount"]
            cw   = [7, 48, 17, 14, 18, 11, 15, 11, 15, 19]
        else:
            hdrs = ["#", "Item & Description", "HSN/SAC", "Qty",
                    "Rate", "IGST %", "IGST Amt", "Amount"]
            cw   = [7, 63, 19, 14, 22, 13, 22, 25]
        cw = [x * mm for x in cw]

        rows = [[self._p(h, "th") for h in hdrs]]
        for i, it in enumerate(self.items, 1):
            q = int(it["qty"]) if it["qty"] == int(it["qty"]) else it["qty"]
            row = [
                self._p(str(i), "td_c"),
                self._p(it["name"], "td"),
                self._p(it["hsn"], "td_c"),
                self._p(f"{q} {it['unit']}", "td_c"),
                self._p(fmt_inr(it["rate"]), "td_r"),
            ]
            if is_intra:
                row += [
                    self._p(f"{it['cgst_pct']:.1f}%", "td_c"),
                    self._p(fmt_inr(it["cgst_amt"]), "td_r"),
                    self._p(f"{it['sgst_pct']:.1f}%", "td_c"),
                    self._p(fmt_inr(it["sgst_amt"]), "td_r"),
                ]
            else:
                row += [
                    self._p(f"{it['igst_pct']:.1f}%", "td_c"),
                    self._p(fmt_inr(it["igst_amt"]), "td_r"),
                ]
            row.append(self._p(fmt_inr(it["final"]), "td_r"))
            rows.append(row)

        ts = [
            ("BACKGROUND",    (0, 0), (-1, 0),  C_DARK),
            ("GRID",          (0, 0), (-1, -1), 0.25, C_BORDER),
            ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING",   (0, 0), (-1, -1), 4),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 4),
            ("TOPPADDING",    (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]
        for idx in range(1, len(rows)):
            if idx % 2 == 0:
                ts.append(("BACKGROUND", (0, idx), (-1, idx), C_ALT_ROW))

        tbl = Table(rows, colWidths=cw, repeatRows=1)
        tbl.setStyle(TableStyle(ts))
        self.story.append(tbl)
        self.story.append(Spacer(1, 4 * mm))

    def _section_totals(self):
        t = self.totals

        # ── right: totals box ────────────────────────────────────────────────
        def row(lbl, val, bold=False, highlight=False):
            ls, vs = ("tl_b", "tv_b") if bold else ("tl", "tv")
            return [self._p(lbl, ls), self._p(val, vs)], highlight

        rows_raw = [row("Sub Total", fmt_inr(t["subtotal"]))]
        if t["disc_pct"]:
            rows_raw.append(row(f"Discount ({t['disc_pct']}%)", f"- {fmt_inr(t['disc_amt'])}"))
            rows_raw.append(row("Taxable Value", fmt_inr(t["taxable"])))
        if t["is_intra"]:
            rows_raw += [row("CGST", fmt_inr(t["cgst"])),
                         row("SGST", fmt_inr(t["sgst"]))]
        else:
            rows_raw.append(row("IGST", fmt_inr(t["igst"])))
        rows_raw.append(row("Total",       fmt_inr(t["grand_total"]), bold=True))
        rows_raw.append(row("Balance Due", fmt_inr(t["grand_total"]), bold=True, highlight=True))

        data = [r for r, _ in rows_raw]
        n    = len(data)

        box_w = self.aw * 0.46
        col_w = box_w / 2
        inner = Table(data, colWidths=[col_w, col_w])
        inner.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0),      (-1, -1),        C_TOTALS_BG),
            ("BACKGROUND",    (0, n - 1),  (-1, n - 1),     C_BAL_BG),
            ("LINEABOVE",     (0, n - 2),  (-1, n - 2),     0.5, C_DARK),
            ("LINEABOVE",     (0, n - 1),  (-1, n - 1),     0.5, C_DARK),
            ("BOX",           (0, 0),      (-1, -1),        0.5, C_BORDER),
            ("ALIGN",         (1, 0),      (1, -1),         "RIGHT"),
            ("LEFTPADDING",   (0, 0),      (-1, -1),        6),
            ("RIGHTPADDING",  (0, 0),      (-1, -1),        6),
            ("TOPPADDING",    (0, 0),      (-1, -1),        4),
            ("BOTTOMPADDING", (0, 0),      (-1, -1),        4),
        ]))

        # ── left: QR code + clickable UPI link ───────────────────────────────
        qr_size = 32 * mm
        self.qr_buf.seek(0)
        qr_img = LinkedImage(self.qr_buf, width=qr_size, height=qr_size,
                              link_url=self.upi_url)

        link_text = (
            f'<a href="{self.upi_url}">'
            f'<u>Pay {fmt_inr(t["grand_total"])} via UPI</u>'
            f'</a>'
        )
        qr_block = [
            self._p("Scan to Pay", "qr_label"),
            Spacer(1, 2 * mm),
            qr_img,
            Spacer(1, 2 * mm),
            self._p("GPay | PhonePe | Paytm | BHIM", "qr_sub"),
            Spacer(1, 1.5 * mm),
            Paragraph(link_text, self.st["upi_link"]),
        ]

        qr_col_w = qr_size + 8 * mm
        mid_w    = self.aw - qr_col_w - box_w

        outer = Table(
            [[qr_block, Spacer(mid_w, 1), inner]],
            colWidths=[qr_col_w, mid_w, box_w],
        )
        outer.setStyle(TableStyle([
            ("VALIGN",        (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING",   (0, 0), (-1, -1), 0),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
            ("TOPPADDING",    (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        self.story.append(outer)
        self.story.append(Spacer(1, 4 * mm))

    def _section_words(self):
        self.story.append(
            self._p(f"Total In Words: {amount_to_words(self.totals['grand_total'])}", "words")
        )
        self.story.append(Spacer(1, 4 * mm))
        self.story.append(self._hr(sb=0, sa=4))

    def _section_notes(self):
        fn = self.customer["first_name"]
        self.story.append(self._p("Notes", "note_hdr"))
        self.story.append(Spacer(1, 2 * mm))
        self.story.append(self._p(
            f"Thank you, {fn}! We appreciate your trust in Purnavah / Greenharvest Agriculture. "
            f"Your order has been carefully packed to ensure the freshest natural products reach you. "
            f"For queries, write to {COMPANY_EMAIL} or visit {COMPANY_WEBSITE}.",
            "note_body",
        ))
        self.story.append(Spacer(1, 3 * mm))
        self.story.append(self._p(
            "This is a computer-generated invoice. "
            "Goods once sold will not be taken back. "
            "All disputes are subject to Raipur jurisdiction.",
            "note_body",
        ))
        self.story.append(Spacer(1, 10 * mm))

    def _section_signature(self):
        sig_w = self.aw * 0.42
        sig_col = [
            Spacer(1, 14 * mm),
            HRFlowable(width=sig_w * 0.85, thickness=0.5, color=C_DARK),
            self._p(f"For {COMPANY_NAME}", "sig"),
            self._p("Authorized Signatory", "sig"),
        ]
        sp = self.aw - sig_w
        outer = Table([[Spacer(sp, 1), sig_col]], colWidths=[sp, sig_w])
        outer.setStyle(TableStyle([
            ("VALIGN",        (0, 0), (-1, -1), "BOTTOM"),
            ("LEFTPADDING",   (0, 0), (-1, -1), 0),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
            ("TOPPADDING",    (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        self.story.append(outer)


# ─────────────────────────────────────────────────────────────────────────────
# ORCHESTRATION
# ─────────────────────────────────────────────────────────────────────────────

def run_invoice(inv_counter, order, products, customers, output_dir):
    """Returns True if a PDF was generated."""
    order_name = order["customer_name"]
    customer = find_customer(order_name, customers)
    if not customer:
        print(f"    WARNING: no customer record found for '{order_name}' - skipped.")
        return False

    items, subtotal = build_items(order["qty_map"], products)
    if not items:
        print(f"    INFO: no valid items for '{order_name}' - skipped.")
        return False

    items, totals = apply_tax(items, subtotal, customer["state_code"])

    os.makedirs(output_dir, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9 _-]", "_", order_name).strip()
    path = os.path.join(output_dir, f"Invoice_{safe}.pdf")

    try:
        InvoicePDF(path, inv_number(inv_counter), customer, items, totals).build()
    except PermissionError:
        print(f"    ERROR: Cannot write {path} — close it in your PDF viewer and re-run.")
        return False
    tax_type = "CGST+SGST" if totals["is_intra"] else "IGST"
    print(f"    OK  {path}  [{tax_type}]  Total: {fmt_inr(totals['grand_total'])}")
    return True


def parse_args():
    p = argparse.ArgumentParser(
        description="Purnavah Invoice Generator — generate PDF invoices from an Excel order sheet.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python generate_invoices.py                              # auto-detect files in current dir\n"
            "  python generate_invoices.py orders.xlsx                  # specify orders file\n"
            "  python generate_invoices.py orders.xlsx customers.xlsx   # specify both\n"
            "  python generate_invoices.py --orders o.xlsx --customers c.xlsx --logo logo.jpg\n"
            "  python generate_invoices.py --customer \"Jane Doe\"         # only one customer\n"
            "  python generate_invoices.py --start 7 --out ./out        # start numbering from INV-000007\n"
            "  python generate_invoices.py --source sheets              # read orders from Google Sheets\n"
        ),
    )
    p.add_argument("orders",    nargs="?", metavar="ORDERS_FILE",
                   help="Path to the orders Excel file (auto-detected if omitted)")
    p.add_argument("customers", nargs="?", metavar="CUSTOMERS_FILE",
                   help="Path to the customers Excel file (auto-detected if omitted)")
    p.add_argument("--orders",    dest="orders_flag",    metavar="FILE",
                   help="Orders Excel file (alternative to positional arg)")
    p.add_argument("--customers", dest="customers_flag", metavar="FILE",
                   help="Customers Excel file (alternative to positional arg)")
    p.add_argument("--logo",  metavar="FILE",  default="",
                   help="Path to company logo image (auto-detected if omitted)")
    p.add_argument("--out",   metavar="DIR",   default="invoices",
                   help="Output directory for PDFs (default: invoices/)")
    p.add_argument("--start", metavar="N",     type=int, default=1,
                   help="Starting invoice number (default: 1, i.e. INV-000001)")
    p.add_argument("--customer", metavar="NAME", default="",
                   help="Generate an invoice for only this customer (matches Orders 'Customer Name')")
    p.add_argument("--source", choices=["local", "sheets"], default="local",
                   help="Where to load orders from: 'local' orders.xlsx (default) or 'sheets' "
                        "(Google Sheets — falls back to local if unreachable)")
    return p.parse_args()


def main():
    global LOGO_PATH

    args = parse_args()

    # Resolve orders file (required for --source local; used as a fallback for --source sheets)
    orders_file = args.orders_flag or args.orders
    if not orders_file:
        candidates = [
            f for f in sorted(Path.cwd().glob("*.xlsx"))
            if not any(k in f.name.lower() for k in
                       ("customer", "client", "crm", "contact", "template", "catalog"))
        ]
        orders_file = str(candidates[0]) if candidates else None
        if orders_file:
            print(f"Auto-detected orders file: {orders_file}")

    if args.source == "local":
        if not orders_file:
            print("ERROR: No orders .xlsx file found in the current directory.")
            print("       Pass it directly:  python generate_invoices.py <orders.xlsx>")
            sys.exit(1)
        if not Path(orders_file).exists():
            sys.exit(f"ERROR: Orders file not found: {orders_file}")

    # Resolve customers file (only needed for --source local; sheets orders carry
    # their own delivery details directly — see customer_from_order())
    customers_file = None
    if args.source == "local":
        customers_file = args.customers_flag or args.customers
        if not customers_file:
            customers_file = find_customers_file(orders_file or str(Path.cwd()))
        if not customers_file or not Path(customers_file).exists():
            sys.exit("ERROR: Customers file not found. Pass it with --customers or as a second positional argument.")

    # Resolve logo
    logo_path = args.logo or find_logo(orders_file or str(Path.cwd()))
    LOGO_PATH = logo_path
    print(f"Logo: {logo_path or '(none found — placeholder will be used)'}")

    print("Loading product catalog...")
    catalog_lookup = get_product_lookup()
    products = to_products_dict(catalog_lookup)
    print(f"  {len(products)} products")

    print("Loading orders...")
    if args.source == "sheets":
        orders = read_orders_from_sheets()
        if orders is None:
            if not orders_file or not Path(orders_file).exists():
                sys.exit("ERROR: Google Sheets unavailable and no local orders.xlsx found to fall back to.")
            orders = load_orders_flat(orders_file)
    else:
        orders = load_orders_flat(orders_file)
    print(f"  {len(orders)} orders")

    if args.customer:
        target = args.customer.strip().lower()
        filtered = [o for o in orders if o["customer_name"].strip().lower() == target]
        if not filtered:
            filtered = [o for o in orders if target in o["customer_name"].strip().lower()]
        if not filtered:
            sys.exit(f"ERROR: No order found for customer matching '{args.customer}'.")
        orders = filtered

    print("Loading customer records...")
    if args.source == "sheets":
        customers = {o["customer_name"]: customer_from_order(o) for o in orders}
        print(f"  {len(customers)} records  (built directly from order delivery details)")
    else:
        cust_sheet = detect_customers_sheet(customers_file)
        customers = load_customers(customers_file, cust_sheet)
        print(f"  {len(customers)} records  (sheet: {cust_sheet})")
    print()

    inv_counter = args.start
    generated = 0
    for order in orders:
        print(f"  {order['customer_name']}")
        if run_invoice(inv_counter, order, products, customers, args.out):
            generated += 1
            inv_counter += 1

    print(f"\nDone. {generated}/{len(orders)} invoices generated in {args.out}/")


if __name__ == "__main__":
    main()
