const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const proxyBase = location.pathname.match(/^\/x\/[^/]+/)?.[0] || "";
let me = null;
let meta = null;
let allPackages = [];
let selectedPackages = new Set();
let uploadedInvoiceLogo = null;
let invoiceById = new Map();

async function api(url, options = {}) {
  const res = await fetch(proxyBase + url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function table(rows, cols) {
  if (!rows.length) return `<p class="muted">Nothing here yet.</p>`;
  return `<table><thead><tr>${cols.map(c => `<th>${c.label}</th>`).join("")}</tr></thead><tbody>${rows.map(row =>
    `<tr>${cols.map(c => `<td>${typeof c.render === "function" ? c.render(row) : row[c.key] ?? ""}</td>`).join("")}</tr>`
  ).join("")}</tbody></table>`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function refreshDashboard() {
  const d = await api("/api/instance/dashboard");
  $("#pendingPackages").textContent = d.pendingPackages;
  $("#totalPackages").textContent = d.totalPackages;
  $("#totalValue").textContent = `$${Number(d.totalValue).toFixed(2)}`;
  $("#openTickets").textContent = d.openTickets;
  const pkgs = await api("/api/instance/packages");
  $("#recentPackages").innerHTML = packageTable(pkgs.slice(0, 8));
}

function filteredPackages() {
  const q = ($("#packageSearch")?.value || "").toLowerCase().trim();
  const storage = $("#packageStorageFilter")?.value || "all";
  const status = $("#packageStatusFilter")?.value || "pending";
  return allPackages.filter(pkg => {
    const matchesText = !q || String(pkg.recipient_name).toLowerCase().includes(q) || String(pkg.tracking_number).toLowerCase().includes(q);
    const matchesStorage = storage === "all" || (storage === "unassigned" ? !pkg.storage_location_id : pkg.storage_location_id === storage);
    const matchesStatus = status === "all" || (status === "pending" ? !pkg.is_delivered : pkg.is_delivered);
    return matchesText && matchesStorage && matchesStatus;
  });
}

function syncSelectionBar() {
  const count = selectedPackages.size;
  $("#selectedPackageCount").textContent = count;
  $("#bulkPackageBar").classList.toggle("hidden", count === 0);
}

function packageTable(pkgs, selectable = false) {
  return table(pkgs, [
    ...(selectable ? [{ label: `<input type="checkbox" id="selectAllPackages" />`, render: r => `<input type="checkbox" class="package-check" data-id="${r.id}" ${selectedPackages.has(r.id) ? "checked" : ""} ${r.is_delivered ? "disabled" : ""} />` }] : []),
    { label: "Tracking", key: "tracking_number" },
    { label: "Recipient", key: "recipient_name" },
    { label: "Storage", render: r => r.storage_name || "-" },
    { label: "Weight", render: r => `${r.weight} lb` },
    { label: "Cost", render: r => `$${Number(r.calculated_cost || 0).toFixed(2)}` },
    { label: "Status", render: r => r.is_delivered ? `<span class="badge ok">Delivered: ${r.picked_up_by_last_name || ""}</span>` : `<span class="badge warn">Pending</span>` },
    { label: "Actions", render: r => r.is_delivered ? "" : `<button onclick="deliver('${r.id}')">Deliver</button>` },
  ]);
}

function bindPackageSelection() {
  $$(".package-check").forEach(input => input.addEventListener("change", () => {
    if (input.checked) selectedPackages.add(input.dataset.id);
    else selectedPackages.delete(input.dataset.id);
    syncSelectionBar();
  }));
  const selectAll = $("#selectAllPackages");
  if (selectAll) {
    const pendingIds = filteredPackages().filter(p => !p.is_delivered).map(p => p.id);
    selectAll.checked = pendingIds.length > 0 && pendingIds.every(id => selectedPackages.has(id));
    selectAll.addEventListener("change", () => {
      if (selectAll.checked) pendingIds.forEach(id => selectedPackages.add(id));
      else pendingIds.forEach(id => selectedPackages.delete(id));
      refreshPackages(false);
    });
  }
  syncSelectionBar();
}

window.deliver = async (id) => {
  const pickedUpByLastName = prompt("Pickup person's last name?");
  if (!pickedUpByLastName) return;
  await api(`/api/instance/packages/${id}`, { method: "PATCH", body: { isDelivered: true, pickedUpByLastName } });
  await refreshPackages();
  await refreshDashboard();
};

async function refreshStorage() {
  const rows = await api("/api/instance/storage");
  $("#packageStorage").innerHTML = `<option value="">Unassigned</option>` + rows.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
  $("#packageStorageFilter").innerHTML = `<option value="all">All storage</option><option value="unassigned">Unassigned</option>` + rows.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
  $("#storageTable").innerHTML = table(rows, [
    { label: "Name", key: "name" },
    { label: "Created", render: r => new Date(r.created_at).toLocaleDateString() },
    { label: "Actions", render: r => `<button class="danger" onclick="deleteStorage('${r.id}')">Delete</button>` },
  ]);
}

window.deleteStorage = async (id) => {
  await api(`/api/instance/storage/${id}`, { method: "DELETE" });
  await refreshStorage();
};

async function refreshPackages(fetchFresh = true) {
  if (fetchFresh) {
    allPackages = await api("/api/instance/packages");
  }
  const visible = filteredPackages();
  const visibleIds = new Set(visible.map(p => p.id));
  selectedPackages = new Set(Array.from(selectedPackages).filter(id => visibleIds.has(id)));
  $("#packageTable").innerHTML = packageTable(visible, true);
  bindPackageSelection();
}

function addInvoiceItem(name = "", quantity = 1, unitPrice = "") {
  const row = document.createElement("div");
  row.className = "inline invoice-item";
  row.innerHTML = `<label>Item <input name="itemName" value="${name}" required /></label>
    <label>Qty <input name="quantity" type="number" min="1" value="${quantity}" required /></label>
    <label>Unit price <input name="unitPrice" type="number" step="0.01" value="${unitPrice}" required /></label>
    <button type="button" onclick="this.parentElement.remove()">Remove</button>`;
  $("#invoiceItems").appendChild(row);
}

async function refreshInvoices() {
  const rows = await api("/api/instance/invoices");
  invoiceById = new Map(rows.map(row => [row.id, row]));
  $("#invoiceTable").innerHTML = table(rows, [
    { label: "Number", key: "invoice_number" },
    { label: "Billed To", render: r => String(r.billed_to).replaceAll("\n", "<br>") },
    { label: "Due", key: "due_date" },
    { label: "Total", render: r => `$${r.total}` },
    { label: "Status", render: r => `<span class="badge ${r.status === "paid" ? "ok" : r.status === "voided" ? "danger" : "warn"}">${r.status}</span>${r.paid_at ? `<br><span class="muted">Paid ${new Date(r.paid_at).toLocaleDateString()}</span>` : ""}` },
    { label: "Actions", render: r => `<div class="row-actions">
      <button onclick="invoiceStatus('${r.id}','${r.status === "paid" ? "unpaid" : "paid"}')">${r.status === "paid" ? "Mark Unpaid" : "Mark Paid"}</button>
      <button class="danger" onclick="invoiceStatus('${r.id}','voided')">Void</button>
      <button onclick="printInvoice('${r.id}')">Print</button>
    </div>` },
  ]);
}

window.invoiceStatus = async (id, status) => {
  await api(`/api/instance/invoices/${id}`, { method: "PATCH", body: { status } });
  await refreshInvoices();
};

window.printInvoice = (id) => {
  const inv = invoiceById.get(id);
  if (!inv) return;
  const title = inv.status === "paid" ? "Receipt" : inv.status === "voided" ? "Voided Invoice" : "Invoice";
  const paidLine = inv.status === "paid" ? `<div class="paid-box">Paid${inv.paid_at ? ` on ${new Date(inv.paid_at).toLocaleDateString()}` : ""}</div>` : "";
  const html = `<!doctype html><html><head><title>${title} ${inv.invoice_number}</title><style>
    body{font-family:Arial,sans-serif;color:#182230;margin:40px}
    .header{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #182230;padding-bottom:18px}
    .brand{display:flex;gap:14px;align-items:center}
    .brand img{width:58px;height:58px;object-fit:contain;border:1px solid #d7dde8;border-radius:8px;padding:6px}
    h1{margin:0;font-size:34px;text-transform:uppercase;letter-spacing:.04em}
    .muted{color:#667085}.meta{text-align:right;line-height:1.6}.paid-box{display:inline-block;margin-top:10px;padding:8px 12px;border-radius:999px;background:#dcfae6;color:#067647;font-weight:700}
    .bill{margin:28px 0;padding:16px;background:#f5f7fb;border-radius:8px}
    table{width:100%;border-collapse:collapse;margin-top:22px}th,td{padding:12px;border-bottom:1px solid #d7dde8;text-align:left}th{text-transform:uppercase;font-size:12px;color:#667085}.num{text-align:right}
    .total{margin-top:22px;text-align:right;font-size:24px;font-weight:800}.footer{margin-top:40px;color:#667085;font-size:12px}
  </style></head><body>
    <div class="header">
      <div class="brand">${meta.invoiceLogo ? `<img src="${meta.invoiceLogo}" alt="" />` : ""}<div><h1>${title}</h1><div class="muted">${meta.invoiceBusinessName || meta.name}</div></div></div>
      <div class="meta"><strong>${inv.invoice_number}</strong><br>Issued ${new Date(inv.created_at).toLocaleDateString()}<br>Due ${new Date(inv.due_date).toLocaleDateString()}${paidLine}</div>
    </div>
    <div class="bill"><strong>Billed to</strong><br>${String(inv.billed_to).replaceAll("\n", "<br>")}</div>
    <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Line Total</th></tr></thead><tbody>${inv.items.map(i => `<tr><td>${i.name}</td><td class="num">${i.quantity}</td><td class="num">$${i.unit_price}</td><td class="num">$${i.total}</td></tr>`).join("")}</tbody></table>
    <div class="total">Total: $${inv.total}</div>
    <div class="footer">${inv.status === "paid" ? "Thank you. This receipt confirms payment has been recorded." : "Please remit payment by the due date listed above."}</div>
  </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
  w.print();
};

async function refreshTickets() {
  const rows = await api("/api/instance/tickets");
  $("#ticketTable").innerHTML = table(rows, [
    { label: "Subject", key: "subject" },
    { label: "Status", render: r => `<span class="badge">${r.status}</span>` },
    { label: "Messages", render: r => r.messages.length },
    { label: "Updated", render: r => new Date(r.updated_at).toLocaleString() },
    { label: "Actions", render: r => `<button onclick="replyTicket('${r.id}')">Reply</button>${me.role !== "employee" ? ` <button onclick="setTicketStatus('${r.id}')">Status</button>` : ""}` },
  ]);
}

window.replyTicket = async (id) => {
  const message = prompt("Reply message");
  if (!message) return;
  await api(`/api/instance/tickets/${id}/messages`, { method: "POST", body: { message } });
  await refreshTickets();
};

window.setTicketStatus = async (id) => {
  const status = prompt("Status: open, in_progress, resolved, closed", "resolved");
  if (!status) return;
  await api(`/api/instance/tickets/${id}`, { method: "PATCH", body: { status } });
  await refreshTickets();
};

async function refreshUsers() {
  if (me.role === "employee") return;
  const rows = await api("/api/instance/users");
  $("#userTable").innerHTML = table(rows, [
    { label: "Name", key: "name" },
    { label: "Email", key: "email" },
    { label: "Role", key: "role" },
    { label: "Status", render: r => r.is_active ? `<span class="badge ok">active</span>` : `<span class="badge">inactive</span>` },
    { label: "Actions", render: r => `<button onclick="toggleUser('${r.id}', ${!r.is_active})">${r.is_active ? "Disable" : "Enable"}</button>` },
  ]);
}

window.toggleUser = async (id, isActive) => {
  await api(`/api/instance/users/${id}`, { method: "PATCH", body: { isActive } });
  await refreshUsers();
};

async function boot() {
  meta = await api("/api/instance/meta");
  $("#brandName").textContent = meta.name;
  $("#loginTitle").textContent = meta.name;
  $("#pageName").textContent = meta.name;
  $("#invoiceBusinessName").value = meta.invoiceBusinessName || meta.name;
  $("#invoiceLogoPreview").src = meta.invoiceLogo || "/assets/generated-icon.png";
  me = await api("/api/instance/me");
  $("#login").classList.toggle("hidden", !!me);
  $("#app").classList.toggle("hidden", !me);
  if (!me) return;
  $$("[data-manager]").forEach(el => el.classList.toggle("hidden", me.role === "employee"));
  await refreshStorage();
  await refreshPackages();
  await refreshDashboard();
  await refreshInvoices();
  await refreshTickets();
  await refreshUsers();
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    me = await api("/api/instance/login", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
    await boot();
  } catch {
    $("#loginError").textContent = "Invalid email or password.";
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/instance/logout", { method: "POST" });
  location.reload();
});

$$(".nav button").forEach(btn => btn.addEventListener("click", async () => {
  $$(".nav button").forEach(b => b.classList.remove("active"));
  $$(".section").forEach(s => s.classList.remove("active"));
  btn.classList.add("active");
  $("#" + btn.dataset.view).classList.add("active");
}));

$("#storageForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/instance/storage", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
  e.target.reset();
  await refreshStorage();
});

$("#packageForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/instance/packages", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
  e.target.reset();
  await refreshPackages();
  await refreshDashboard();
});

$("#packageRefresh").addEventListener("click", () => refreshPackages(false));
$("#packageSearch").addEventListener("input", () => refreshPackages(false));
$("#packageStorageFilter").addEventListener("change", () => refreshPackages(false));
$("#packageStatusFilter").addEventListener("change", () => refreshPackages(false));
$("#clearPackageSelection").addEventListener("click", () => {
  selectedPackages.clear();
  refreshPackages(false);
});
$("#bulkDeliverBtn").addEventListener("click", async () => {
  const pickedUpByLastName = prompt("Pickup person's last name for selected packages?");
  if (!pickedUpByLastName || selectedPackages.size === 0) return;
  await api("/api/instance/packages/bulk", {
    method: "PATCH",
    body: { packageIds: Array.from(selectedPackages), isDelivered: true, pickedUpByLastName },
  });
  selectedPackages.clear();
  await refreshPackages();
  await refreshDashboard();
});
$("#packageSearch").addEventListener("keydown", e => { if (e.key === "Enter") refreshPackages(false); });
$("#archiveBtn").addEventListener("click", async () => {
  const rows = await api(`/api/instance/archive/search?q=${encodeURIComponent($("#archiveSearch").value)}`);
  $("#archiveTable").innerHTML = table(rows, [
    { label: "Tracking", key: "tracking_number" },
    { label: "Recipient", key: "recipient_name" },
    { label: "Picked Up By", key: "picked_up_by_last_name" },
    { label: "Delivered", render: r => new Date(r.delivered_at).toLocaleDateString() },
  ]);
});

$("#addInvoiceItem").addEventListener("click", () => addInvoiceItem());
$("#invoiceLogoInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 750000) {
    alert("Please choose an image under 750KB.");
    e.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    uploadedInvoiceLogo = reader.result;
    $("#invoiceLogoPreview").src = uploadedInvoiceLogo;
  };
  reader.readAsDataURL(file);
});
$("#saveInvoiceBranding").addEventListener("click", async () => {
  const updated = await api("/api/instance/settings", {
    method: "PATCH",
    body: {
      invoiceBusinessName: $("#invoiceBusinessName").value,
      ...(uploadedInvoiceLogo ? { invoiceLogo: uploadedInvoiceLogo } : {}),
    },
  });
  meta.invoiceBusinessName = updated.invoice_business_name;
  meta.invoiceLogo = updated.invoice_logo;
  uploadedInvoiceLogo = null;
  alert("Invoice branding saved.");
});
$("#invoiceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const names = fd.getAll("itemName");
  const quantities = fd.getAll("quantity");
  const prices = fd.getAll("unitPrice");
  await api("/api/instance/invoices", {
    method: "POST",
    body: {
      billedTo: fd.get("billedTo"),
      dueDate: fd.get("dueDate"),
      items: names.map((name, i) => ({ name, quantity: quantities[i], unitPrice: prices[i] })),
    },
  });
  e.target.reset();
  $("#invoiceItems").innerHTML = "";
  addInvoiceItem();
  await refreshInvoices();
});

$("#ticketForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/instance/tickets", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
  e.target.reset();
  await refreshTickets();
});

$("#userForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/instance/users", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
  e.target.reset();
  await refreshUsers();
});

$("#backupBtn").addEventListener("click", async () => {
  const b = await api("/api/instance/backups", { method: "POST" });
  $("#backupResult").textContent = `Backup ${b.id} created at ${new Date(b.created_at).toLocaleString()}`;
});

$("#invoiceForm [name=dueDate]").value = today();
addInvoiceItem();
boot();
