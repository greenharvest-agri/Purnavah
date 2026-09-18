/**
 * invoice-shared.js — Purnavah invoice PDF rendering, shared between
 * admin.html (Generate/reprint from an order card) and invoices.html
 * (Reprint from the invoice list) — Phase 6 / Issue 11.
 *
 * Both pages build their own `d` object (from live edit state in admin.html,
 * from persisted order fields in invoices.html) and pass it to
 * buildInvoiceHtml(d), so the printed document looks identical regardless
 * of which page generated it. Each page must define `escapeHtml(s)` itself
 * (trivial, already duplicated per-page) before calling buildInvoiceHtml.
 */

// Update to your live order-form URL — shown as a QR code on every invoice.
const ORDER_FORM_URL = 'https://purnavah-orders.pages.dev';

// UPI collection details — used to build the "pay via UPI" QR/link on
// invoices and in the order-confirmation WhatsApp/email messages.
const UPI_VPA = 'greenharvestagri@upi';
const UPI_PAYEE_NAME = 'Greenharvest Agriculture Private Limited';

// amount: number (rupees); note: short text shown as the UPI transaction note.
function buildUpiPayLink(amount, note) {
  const params = new URLSearchParams({
    pa: UPI_VPA, pn: UPI_PAYEE_NAME, am: amount.toFixed(2), cu: 'INR', tn: note
  });
  // URLSearchParams encodes spaces as "+" (form encoding), but UPI apps parse
  // this as a plain URI and don't decode "+" back to a space — that breaks
  // the "pn" field (has spaces) enough that GPay/PhonePe/Paytm reject the
  // intent and fall back to their generic pay/search screen with the raw
  // link text instead of a pre-filled payment screen. Re-encode spaces as
  // %20 (proper RFC 3986 URI encoding) so the link parses correctly.
  return `upi://pay?${params.toString().replace(/\+/g, '%20')}`;
}

function numberToWords(num) {
  const a = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const b = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function inWords(n) {
    if (n < 20) return a[n];
    if (n < 100) return b[Math.floor(n/10)] + (n%10 ? ' ' + a[n%10] : '');
    if (n < 1000) return a[Math.floor(n/100)] + ' Hundred' + (n%100 ? ' And ' + inWords(n%100) : '');
    if (n < 100000) return inWords(Math.floor(n/1000)) + ' Thousand' + (n%1000 ? ', ' + inWords(n%1000) : '');
    return inWords(Math.floor(n/100000)) + ' Lakh' + (n%100000 ? ', ' + inWords(n%100000) : '');
  }
  const rupees = Math.floor(num);
  const paise = Math.round((num - rupees) * 100);
  let words = 'Indian Rupee ' + (rupees > 0 ? inWords(rupees) : 'Zero');
  if (paise > 0) words += ' And ' + inWords(paise) + ' Paise';
  return words + ' Only';
}

// d: { invoiceNo, date, dueDate, customer, lineItems, oosLineItems, subTotal,
//      discountAmt, taxableValue, totalCgst, totalSgst, totalIgst, totalGst,
//      grandTotal, isIntraState, invoiceBadge:{label,bg,color}, paymentReceived }
// lineItems entries: { sn, name, qty, price, rate, hsn, discPct, discAmt, cgstRate,
//      cgstAmt, sgstRate, sgstAmt, igstRate, igstAmt, totalTaxAmt, amount, grossAmount }
// `rate` is the ex-GST per-unit rate (drives the "Rate" column below) —
// `price` (tax-inclusive MRP) is carried on the object but not rendered here,
// since showing it as "Rate" would make Qty × Rate not equal Amount, and
// Sub Total − Discount not equal Taxable Value, on the printed page itself.
function buildInvoiceHtml(d) {
  const itemRows = d.lineItems.map(li => d.isIntraState ? `
    <tr>
      <td>${li.sn}</td>
      <td>${escapeHtml(li.name)}</td>
      <td class="num">${li.qty}</td>
      <td class="num">₹${li.rate.toFixed(2)}</td>
      <td class="num">${li.discPct}%</td>
      <td class="num">₹${li.discAmt.toFixed(2)}</td>
      <td class="num">${li.cgstRate}%</td>
      <td class="num">₹${li.cgstAmt.toFixed(2)}</td>
      <td class="num">${li.sgstRate}%</td>
      <td class="num">₹${li.sgstAmt.toFixed(2)}</td>
      <td class="num">₹${li.amount.toFixed(2)}</td>
    </tr>` : `
    <tr>
      <td>${li.sn}</td>
      <td>${escapeHtml(li.name)}</td>
      <td class="num">${li.qty}</td>
      <td class="num">₹${li.rate.toFixed(2)}</td>
      <td class="num">${li.discPct}%</td>
      <td class="num">₹${li.discAmt.toFixed(2)}</td>
      <td class="num">${li.igstRate}%</td>
      <td class="num">₹${li.igstAmt.toFixed(2)}</td>
      <td class="num">₹${li.amount.toFixed(2)}</td>
    </tr>`).join('');

  const colCount = d.isIntraState ? 11 : 9;
  const oosRows = d.oosLineItems.length ? `
    <tr><td colspan="${colCount}" style="padding-top:14px;font-weight:600;color:#B91C1C;border:none">Removed — out of stock:</td></tr>
    ${d.oosLineItems.map(li => `<tr style="color:#7A6F61"><td></td><td>${escapeHtml(li.name)}</td><td class="num">${li.qty}</td><td colspan="${colCount-3}" class="num">—</td></tr>`).join('')}
  ` : '';

  const tableHead = d.isIntraState
    ? `<tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Disc %</th><th class="num">Disc Amt</th><th class="num">CGST %</th><th class="num">CGST Amt</th><th class="num">SGST %</th><th class="num">SGST Amt</th><th class="num">Amount</th></tr>`
    : `<tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Disc %</th><th class="num">Disc Amt</th><th class="num">IGST %</th><th class="num">IGST Amt</th><th class="num">Amount</th></tr>`;

  const gstTotalsRows = d.isIntraState
    ? `<div class="totals-row"><span>CGST</span><span>₹${d.totalCgst.toLocaleString('en-IN', {minimumFractionDigits:2})}</span></div>
       <div class="totals-row"><span>SGST</span><span>₹${d.totalSgst.toLocaleString('en-IN', {minimumFractionDigits:2})}</span></div>`
    : `<div class="totals-row"><span>IGST</span><span>₹${d.totalIgst.toLocaleString('en-IN', {minimumFractionDigits:2})}</span></div>`;

  const placeOfSupply = `${escapeHtml(d.customer.state || 'Unknown')}${d.isIntraState ? ' (Intra-state)' : ''}`;

  const paymentSection = d.paymentReceived ? `
    <div class="payment-received">
      <div class="payment-received-title">Payment received</div>
      Mode: ${escapeHtml(d.paymentReceived.mode || '—')} &nbsp;·&nbsp;
      UTR/Ref: ${escapeHtml(d.paymentReceived.ref || '—')} &nbsp;·&nbsp;
      Date: ${escapeHtml(d.paymentReceived.date || '—')} &nbsp;·&nbsp;
      Amount: ₹${(d.paymentReceived.amount || 0).toLocaleString('en-IN', {minimumFractionDigits:2})}
    </div>` : '';

  // Outstanding amount = this invoice's total minus whatever's already been
  // recorded as paid — not just d.grandTotal, so a QR on a reprinted/
  // partially-paid invoice doesn't ask the customer to pay the full amount again.
  const amountPaid = d.customer.amountPaid || 0;
  const payableAmount = Math.max(0, Math.round((d.grandTotal - amountPaid) * 100) / 100);
  const upiLink = buildUpiPayLink(payableAmount, `Invoice ${d.invoiceNo}`);
  const upiQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=90x90&data=${encodeURIComponent(upiLink)}`;
  const upiSection = payableAmount > 0 ? `
    <a href="${upiLink}" style="text-decoration:none;text-align:center;flex-shrink:0">
      <img src="${upiQrUrl}" width="86" height="86" alt="Pay via UPI">
      <div style="font-size:9.5px;color:#666;margin-top:2px">Scan / tap to pay via UPI</div>
    </a>` : '';

  // goqr.me's free API — chart.googleapis.com's old QR endpoint was shut
  // down years ago and would render a broken image here.
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(ORDER_FORM_URL)}`;
  const qrSection = `
    <div style="display:flex;align-items:flex-start;gap:16px;margin-top:24px;padding-top:16px;border-top:1px solid #eee">
      <img src="${qrUrl}" width="80" height="80" alt="Order QR code">
      <div style="font-size:11px;color:#666;line-height:1.7">
        <div style="font-weight:700;font-size:12px;color:#333;margin-bottom:4px">Place your next order</div>
        Scan the QR code or visit:<br>
        <a href="${ORDER_FORM_URL}" style="color:#3A5428">${ORDER_FORM_URL}</a><br>
        Call / WhatsApp: +91 83389 62474
      </div>
    </div>`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${d.invoiceNo}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:'Helvetica Neue',Arial,sans-serif}
body{padding:50px 60px;color:#1a1a1a;font-size:13px;position:relative}
.invoice-badge{position:fixed;top:24px;right:60px;padding:6px 18px;border-radius:6px;font-weight:700;font-size:13px;letter-spacing:.08em;background:${d.invoiceBadge.bg};color:${d.invoiceBadge.color}}
.top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:30px}
h1{font-size:26px;letter-spacing:.02em}
.meta{font-size:12px;color:#555;margin-top:8px;line-height:1.6}
.balance-label{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em}
.balance-amt{font-size:26px;font-weight:700;margin-top:4px}
.company{text-align:right;font-size:12px;line-height:1.6;color:#333}
.company b{font-size:14px}
hr{border:none;border-top:1px solid #ddd;margin:20px 0}
.info-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:24px;font-size:12px}
.info-grid .label{color:#888;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.info-grid b{font-size:13px}
table{width:100%;border-collapse:collapse;margin-top:10px}
th{background:#2d4020;color:#fff;font-size:10.5px;text-transform:uppercase;letter-spacing:.03em;padding:8px 10px;text-align:left}
td{padding:8px 10px;border-bottom:1px solid #eee;font-size:12.5px}
.num{text-align:right}
th.num{text-align:right}
.totals{width:280px;margin-left:auto;margin-top:20px;font-size:13px}
.totals-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee}
.totals-row.grand{font-weight:700;font-size:15px;background:#EDF2E8;padding:10px;border-radius:4px;margin-top:6px}
.words{font-style:italic;font-size:12px;margin-top:20px;color:#333}
.payment-received{margin-top:20px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:6px;padding:12px 16px;font-size:12.5px;color:#14532D}
.payment-received-title{font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:10.5px;margin-bottom:6px}
.notes{margin-top:30px;font-size:11.5px;color:#666;border-top:1px solid #ddd;padding-top:16px;line-height:1.7}
.print-btn{position:fixed;top:20px;right:20px;background:#3A5428;color:#fff;border:none;padding:10px 18px;border-radius:6px;font-size:13px;cursor:pointer}
@media print{.print-btn{display:none}}
</style></head>
<body>
<button class="print-btn" onclick="window.print()">Print / Save PDF</button>
<div class="invoice-badge">${d.invoiceBadge.label}</div>
<div class="top">
  <div>
    <h1>TAX INVOICE</h1>
    <div style="display:flex;align-items:flex-end;gap:14px">
      <div class="meta">
        Invoice # ${d.invoiceNo}<br>
        Date: ${d.date} | Due: ${d.dueDate}<br><br>
        <span class="balance-label">Balance Due</span><br>
        <span class="balance-amt">₹${payableAmount.toLocaleString('en-IN', {minimumFractionDigits:2})}</span>
      </div>
      ${upiSection}
    </div>
  </div>
  <div class="company">
    <b>Greenharvest Agriculture Private Limited</b><br>
    Plot 122/3, Anjani, Gaurela-Pendra-Marwahi, Chhattisgarh – 495117<br>
    GSTIN: 22AALCG0905G1Z1<br>
    Email: priyam.jaiswal@globalgreenharvest.com<br>
    Web: www.purnavah.com
  </div>
</div>
<hr>
<div class="info-grid">
  <div><div class="label">Bill To</div><b>${escapeHtml(d.customer.customerName)}</b><br>${escapeHtml(d.customer.address)}<br>${escapeHtml(d.customer.pincode)}<br>${escapeHtml(d.customer.state)}</div>
  <div><div class="label">Ship To</div><b>${escapeHtml(d.customer.customerName)}</b><br>${escapeHtml(d.customer.address)}<br>${escapeHtml(d.customer.pincode)}<br>${escapeHtml(d.customer.state)}</div>
  <div><div class="label">Payment Terms</div>Net 15<br><br><div class="label">Phone</div>${escapeHtml(d.customer.phone)}</div>
</div>
<div style="font-size:12px;font-style:italic;color:#555;margin-bottom:16px">Place Of Supply: ${placeOfSupply}</div>
<table>
  <thead>${tableHead}</thead>
  <tbody>${itemRows}${oosRows}</tbody>
</table>
<div class="totals">
  <div class="totals-row"><span>Sub Total</span><span>₹${d.subTotal.toLocaleString('en-IN', {minimumFractionDigits:2})}</span></div>
  ${d.discountAmt > 0 ? `<div class="totals-row"><span>Discount</span><span>− ₹${d.discountAmt.toLocaleString('en-IN', {minimumFractionDigits:2})}</span></div>` : ''}
  <div class="totals-row"><span>Taxable Value</span><span>₹${d.taxableValue.toLocaleString('en-IN', {minimumFractionDigits:2})}</span></div>
  ${gstTotalsRows}
  <div class="totals-row grand"><span>Total</span><span>₹${d.grandTotal.toLocaleString('en-IN', {minimumFractionDigits:2})}</span></div>
</div>
<div class="words">Total In Words: ${numberToWords(d.grandTotal)}</div>
${qrSection}
${paymentSection}
<div class="notes">
  Thank you, ${escapeHtml(d.customer.customerName)}! We appreciate your trust in Purnavah / Greenharvest Agriculture. Your order has been carefully packed to ensure the freshest natural products reach you. For queries, write to priyam.jaiswal@globalgreenharvest.com or visit www.purnavah.com.<br><br>
  This is a computer-generated invoice. Goods once sold will not be taken back. All disputes are subject to Raipur jurisdiction.
</div>
</body></html>`;
}

// Packing checklist (added 2026-08-11) — a plain pick-list for warehouse
// staff, deliberately carrying no pricing/MRP/discount/GST anywhere (see
// admin.html's downloadPackingChecklist/computeChecklistData, which always
// builds `d` from a *fresh* server fetch rather than local edit state, so
// this document reflects exactly what's saved on the sheet right now).
// d: { orderLabel, customerName, phone, address, pincode, notes,
//      items: [{name, qty}], totalQty, estWeight }
function buildPackingChecklistHtml(d) {
  const itemRows = d.items.map(it => `
    <tr>
      <td class="chk">☐</td>
      <td>${escapeHtml(it.name)}</td>
      <td class="num">${it.qty}</td>
    </tr>`).join('');

  const notesSection = d.notes ? `<div class="checklist-notes"><strong>Customer notes:</strong> ${escapeHtml(d.notes)}</div>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Packing Checklist — ${escapeHtml(d.orderLabel)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:'Helvetica Neue',Arial,sans-serif}
body{padding:50px 60px;color:#1a1a1a;font-size:13px}
h1{font-size:22px;letter-spacing:.01em;text-align:center;margin-bottom:18px}
.meta{font-size:12.5px;color:#333;line-height:1.7;margin-bottom:16px}
.meta b{color:#111}
table{width:100%;border-collapse:collapse;margin-top:6px}
th{background:#2d4020;color:#fff;font-size:10.5px;text-transform:uppercase;letter-spacing:.03em;padding:8px 10px;text-align:left}
td{padding:9px 10px;border-bottom:1px solid #eee;font-size:13px}
tr:nth-child(even) td{background:#F7F9F5}
.chk{width:36px;text-align:center;font-size:16px;color:#555}
.num{text-align:right}
th.num{text-align:right}
.checklist-footer{margin-top:18px;font-size:12.5px;color:#333;line-height:1.8;border-top:1px solid #ddd;padding-top:14px}
.checklist-notes{margin-top:14px;font-size:12.5px;color:#7C5C3A;background:#FBF3E1;border-radius:6px;padding:10px 14px}
.print-btn{position:fixed;top:20px;right:20px;background:#3A5428;color:#fff;border:none;padding:10px 18px;border-radius:6px;font-size:13px;cursor:pointer}
@media print{.print-btn{display:none}}
</style></head>
<body>
<button class="print-btn" onclick="window.print()">Print / Save PDF</button>
<h1>Purnavah — Packing Checklist</h1>
<div class="meta">
  Order #${escapeHtml(d.orderLabel)}<br>
  Ship to: <b>${escapeHtml(d.customerName)}</b>, ${escapeHtml(d.address)}, ${escapeHtml(d.pincode)}<br>
  Phone: ${escapeHtml(d.phone)}<br>
  Total: ${d.totalQty} item${d.totalQty !== 1 ? 's' : ''}, approx. ${d.estWeight} kg
</div>
${notesSection}
<table>
  <thead><tr><th>✓</th><th>Product</th><th class="num">Qty</th></tr></thead>
  <tbody>${itemRows}</tbody>
</table>
<div class="checklist-footer">
  Total pieces: ${d.totalQty} &nbsp;|&nbsp; Weight check: approx. ${d.estWeight} kg
</div>
</body></html>`;
}
