# python/load_catalog.py
"""
Shared catalog loader. Import this in every script.
Usage:
    from load_catalog import load_catalog
    products = load_catalog()   # returns list of active product dicts
    all_products = load_catalog(active_only=False)  # includes inactive
"""
import pandas as pd
import os

CATALOG_PATHS = [
    "catalog.xlsx",           # if running from python/ folder
    "../catalog.xlsx",        # if repo root has the file
]

def load_catalog(active_only=True):
    """
    Returns a list of product dicts from catalog.xlsx.
    Each dict has keys: product_name, category, display_name, unit,
    pack_size, mrp, hsn, gst_pct, stock, active, wa_key, notes

    If active_only=True (default), only returns rows where:
      - Active == 'Y'
      - Stock > 0
    """
    path = None
    for p in CATALOG_PATHS:
        if os.path.exists(p):
            path = p
            break
    if path is None:
        raise FileNotFoundError(
            "catalog.xlsx not found. Expected at repo root or python/../catalog.xlsx\n"
            "Create it by running: python _make_catalog.py"
        )

    df = pd.read_excel(path, sheet_name="Catalog", dtype={"HSN/SAC": str})
    df.columns = [c.strip() for c in df.columns]

    # Normalise column access
    df = df.rename(columns={
        "Product Name": "product_name",
        "Category":     "category",
        "Display Name": "display_name",
        "Unit":         "unit",
        "Pack Size":    "pack_size",
        "MRP":          "mrp",
        "HSN/SAC":      "hsn",
        "GST%":         "gst_pct",
        "Stock":        "stock",
        "Active":       "active",
        "WA Key":       "wa_key",
        "Notes":        "notes",
    })

    # Fill missing display names with product_name
    df["display_name"] = df["display_name"].fillna("").where(
        df["display_name"].fillna("") != "", df["product_name"]
    )

    # Auto-generate WA Key: "Display Name (Pack Size)"
    # e.g. "Mustard Oil — Organic (1 L)"
    df["wa_key"] = df["display_name"].str.strip() + " (" + df["pack_size"].str.strip() + ")"

    # Normalise Active column
    df["active"] = df["active"].fillna("N").astype(str).str.strip().str.upper()
    df["stock"]  = pd.to_numeric(df["stock"], errors="coerce").fillna(0).astype(int)

    if active_only:
        df = df[(df["active"] == "Y") & (df["stock"] > 0)]

    return df.to_dict("records")


def build_wa_product_map():
    """
    Returns a dict mapping WA message key → product_name (Excel column name).
    Used by parse_whatsapp.py. Replaces the hardcoded PRODUCT_MAP.
    Example: {"Mustard Oil — Organic (1 L)": "Mustard Oil Organic 1L"}
    """
    products = load_catalog(active_only=False)  # include inactive for parsing old orders
    return {p["wa_key"]: p["product_name"] for p in products}


def get_product_lookup():
    """
    Returns a dict mapping product_name → full product dict.
    Used by generate_invoices.py to look up rate/HSN/GST.
    """
    products = load_catalog(active_only=False)
    return {p["product_name"]: p for p in products}
