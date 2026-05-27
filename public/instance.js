const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const proxyBase = location.pathname.match(/^\/x\/[^/]+/)?.[0] || "";
let me = null;
let meta = null;
let allPackages = [];
let selectedPackages = new Set();
let uploadedInvoiceLogo = null;
let invoiceById = new Map();
let expandedPackages = new Set();
let contacts = [];
let reportData = null;
let openActionMenu = null;

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

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function chooseImage() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve("");
      if (file.size > 1000000) {
        alert("Please choose a photo under 1MB.");
        return resolve("");
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    };
    input.click();
  });
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
    const matchesStatus = status === "all" || (status === "pending" ? pkg.status !== "delivered" : pkg.status === status);
    return matchesText && matchesStorage && matchesStatus;
  });
}

function syncSelectionBar() {
  const count = selectedPackages.size;
  const total = allPackages
    .filter(pkg => selectedPackages.has(pkg.id))
    .reduce((sum, pkg) => sum + Number(pkg.calculated_cost || 0), 0);
  $("#selectedPackageCount").textContent = count;
  $("#selectedPackageTotal").textContent = `$${total.toFixed(2)}`;
  $("#bulkPackageBar").classList.toggle("hidden", count === 0);
}

function packageTable(pkgs, selectable = false) {
  if (!pkgs.length) return `<p class="muted">Nothing here yet.</p>`;
  const colSpan = selectable ? 9 : 8;
  const rows = pkgs.map(pkg => {
    const creator = pkg.created_by_name || pkg.created_by_email || "Unknown";
    const delivered = pkg.delivered_at ? new Date(pkg.delivered_at).toLocaleString() : "Not delivered";
    const received = pkg.created_at ? new Date(pkg.created_at).toLocaleString() : "-";
    const statusClass = pkg.status === "delivered" ? "ok" : pkg.status === "attempted" ? "warn" : pkg.status === "routed" ? "route" : pkg.status === "stored" ? "stored" : "received";
    const status = `<span class="badge ${statusClass}">${pkg.status || (pkg.is_delivered ? "delivered" : "received")}</span>${pkg.picked_up_by_last_name ? `<br><span class="muted">${pkg.picked_up_by_last_name}</span>` : ""}`;
    return `<tr>
      ${selectable ? `<td><input type="checkbox" class="package-check" data-id="${pkg.id}" ${selectedPackages.has(pkg.id) ? "checked" : ""} ${pkg.is_delivered ? "disabled" : ""} /></td>` : ""}
      <td><button class="ghost" onclick="togglePackageDetails('${pkg.id}')">${expandedPackages.has(pkg.id) ? "Hide" : "Details"}</button></td>
      <td>${pkg.tracking_number}</td>
      <td>${pkg.recipient_name}</td>
      <td>${pkg.storage_name || "-"}</td>
      <td>${pkg.weight} lb</td>
      <td>$${Number(pkg.calculated_cost || 0).toFixed(2)}</td>
      <td>${status}</td>
      <td class="actions-cell">
        <div class="action-menu">
          <button onclick="toggleActionMenu('${pkg.id}')">Actions ▾</button>
          ${openActionMenu === pkg.id ? `<div class="action-menu-list">
            ${pkg.is_delivered ? "" : `<button onclick="deliver('${pkg.id}')">Deliver</button>`}
            ${pkg.is_delivered ? "" : `<button onclick="setPackageStatus('${pkg.id}','routed')">Route</button><button onclick="setPackageStatus('${pkg.id}','stored')">Store</button><button onclick="setPackageStatus('${pkg.id}','attempted')">Attempted</button>`}
            <button onclick="printLabel('${pkg.id}')">Print Label</button>
          </div>` : ""}
        </div>
      </td>
    </tr>
    ${expandedPackages.has(pkg.id) ? `<tr class="detail-row"><td colspan="${colSpan}">
      <div class="detail-grid">
        <div><strong>Date Received</strong>${received}</div>
        <div><strong>Date Delivered</strong>${delivered}</div>
        <div><strong>Added By</strong>${creator}</div>
        <div><strong>Contact</strong>${pkg.contact_email || pkg.contact_mailbox || "No contact linked"}</div>
        <div><strong>Route/Store</strong>${pkg.routed_at ? `Routed ${new Date(pkg.routed_at).toLocaleString()}` : "Not routed"}<br>${pkg.stored_at ? `Stored ${new Date(pkg.stored_at).toLocaleString()}` : "Not stored"}</div>
        <div><strong>Proof</strong>${pkg.delivery_signature ? "Signature captured" : "No signature"}<br>${pkg.delivery_photo ? "Photo attached" : "No photo"}<br>${pkg.id_verification || ""}</div>
        <div><strong>Notes</strong>${pkg.notes || "No notes"}${pkg.delivery_notes ? `<br>${pkg.delivery_notes}` : ""}</div>
      </div>
    </td></tr>` : ""}`;
  }).join("");
  return `<table><thead><tr>
    ${selectable ? `<th><input type="checkbox" id="selectAllPackages" /></th>` : ""}
    <th></th><th>Tracking</th><th>Recipient</th><th>Storage</th><th>Weight</th><th>Cost</th><th>Status</th><th>Actions</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

window.togglePackageDetails = (id) => {
  if (expandedPackages.has(id)) expandedPackages.delete(id);
  else expandedPackages.add(id);
  refreshPackages(false);
};

window.toggleActionMenu = (id) => {
  openActionMenu = openActionMenu === id ? null : id;
  refreshPackages(false);
};

window.setPackageStatus = async (id, status) => {
  await api(`/api/instance/packages/${id}`, { method: "PATCH", body: { status } });
  await refreshPackages();
  await refreshDashboard();
};

window.printLabel = (id) => {
  const pkg = allPackages.find(p => p.id === id);
  if (!pkg) return;
  const code = pkg.label_code || pkg.tracking_number;
  const html = `<!doctype html><html><head><title>Package Label</title><style>
    body{font-family:Arial,sans-serif;margin:18px}.label{width:320px;border:2px solid #182230;padding:16px;border-radius:10px}
    h1{font-size:18px;margin:0 0 10px}.big{font-size:20px;font-weight:800}.barcode{font-family:monospace;letter-spacing:2px;border-top:1px solid #222;border-bottom:1px solid #222;padding:10px 0;margin:12px 0}
  </style></head><body><div class="label"><h1>${meta.name}</h1><div class="big">${pkg.recipient_name}</div><div>${pkg.storage_name || "Unassigned"}</div><div class="barcode">${code}</div><div>${pkg.tracking_number}</div><div>${pkg.weight} lb</div></div></body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
  w.print();
};

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
  const deliveryNotes = prompt("Delivery notes or ID verification?") || "";
  const deliverySignature = prompt("Signature name (optional)") || "";
  const deliveryPhoto = confirm("Attach a delivery photo?") ? await chooseImage() : "";
  await api(`/api/instance/packages/${id}`, { method: "PATCH", body: { status: "delivered", isDelivered: true, pickedUpByLastName, deliveryNotes, deliverySignature, deliveryPhoto } });
  await refreshPackages();
  await refreshDashboard();
};

async function refreshContacts() {
  const q = encodeURIComponent($("#contactSearch")?.value || "");
  contacts = await api(`/api/instance/contacts?q=${q}`);
  const options = `<option value="">No linked contact</option>` + contacts.map(c => `<option value="${c.id}">${[c.first_name, c.last_name].filter(Boolean).join(" ")}${c.mailbox ? ` - ${c.mailbox}` : ""}</option>`).join("");
  $("#packageContact").innerHTML = options;
  $("#contactTable").innerHTML = table(contacts, [
    { label: "Name", render: c => `${c.first_name || ""} ${c.last_name}`.trim() },
    { label: "Email", key: "email" },
    { label: "Mailbox", key: "mailbox" },
    { label: "Dept/Building", render: c => [c.department, c.building].filter(Boolean).join(" / ") },
  ]);
}

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

async function refreshNotifications() {
  if (me.role === "employee") return;
  const data = await api("/api/instance/notifications");
  $("#notificationTemplates").innerHTML = data.templates.map(t => `<div class="template-card">
    <div class="inline">
      <label>Event <input value="${t.event}" disabled /></label>
      <label>Enabled <select data-template-enabled="${t.id}"><option value="false">Disabled</option><option value="true" ${t.enabled ? "selected" : ""}>Enabled</option></select></label>
      <label>Delay hours <input data-template-delay="${t.id}" type="number" step="0.25" value="${t.delay_hours}" /></label>
    </div>
    <label>Subject <input data-template-subject="${t.id}" value="${t.subject.replaceAll('"', "&quot;")}" /></label>
    <label>Body <textarea data-template-body="${t.id}">${t.body}</textarea></label>
    <button onclick="saveTemplate('${t.id}')">Save Template</button>
  </div>`).join("");
  $("#notificationLogs").innerHTML = table(data.logs, [
    { label: "Event", key: "event" },
    { label: "Recipient", key: "recipient" },
    { label: "Status", key: "status" },
    { label: "Created", render: r => new Date(r.created_at).toLocaleString() },
  ]);
}

window.saveTemplate = async (id) => {
  await api(`/api/instance/notifications/${id}`, {
    method: "PATCH",
    body: {
      enabled: document.querySelector(`[data-template-enabled="${id}"]`).value === "true",
      delayHours: document.querySelector(`[data-template-delay="${id}"]`).value,
      subject: document.querySelector(`[data-template-subject="${id}"]`).value,
      body: document.querySelector(`[data-template-body="${id}"]`).value,
    },
  });
  await refreshNotifications();
};

async function refreshReports() {
  const from = $("#reportFrom").value || "1970-01-01";
  const to = $("#reportTo").value || "2999-12-31";
  reportData = await api(`/api/instance/reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const counts = Object.fromEntries(reportData.summary.map(row => [row.status, row.count]));
  $("#reportSummary").innerHTML = ["received", "routed", "stored", "attempted", "delivered"].map(status =>
    `<div class="card stat"><div class="value">${counts[status] || 0}</div><div class="label">${status}</div></div>`
  ).join("");
  $("#reportTable").innerHTML = table(reportData.packages, [
    { label: "Tracking", key: "tracking_number" },
    { label: "Recipient", key: "recipient_name" },
    { label: "Weight", key: "weight" },
    { label: "Status", key: "status" },
    { label: "Received", render: r => new Date(r.created_at).toLocaleDateString() },
    { label: "Delivered", render: r => r.delivered_at ? new Date(r.delivered_at).toLocaleDateString() : "-" },
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
  await refreshContacts();
  await refreshPackages();
  await refreshDashboard();
  await refreshInvoices();
  await refreshTickets();
  await refreshUsers();
  await refreshReports();
  await refreshNotifications();
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

$("#contactForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/instance/contacts", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
  e.target.reset();
  await refreshContacts();
});

$("#refreshContactsBtn").addEventListener("click", refreshContacts);
$("#contactSearch").addEventListener("input", refreshContacts);
$("#packageContact").addEventListener("change", () => {
  const c = contacts.find(row => row.id === $("#packageContact").value);
  if (c) document.querySelector('#packageForm [name="recipientName"]').value = `${c.first_name || ""} ${c.last_name}`.trim();
});

$("#importContactsBtn").addEventListener("click", async () => {
  const file = $("#contactCsv").files?.[0];
  if (!file) return alert("Choose a CSV file first.");
  const text = await file.text();
  const [headerLine, ...lines] = text.trim().split(/\r?\n/);
  const headers = headerLine.split(",").map(h => h.trim());
  const contacts = lines.map(line => {
    const values = line.split(",").map(v => v.trim());
    return Object.fromEntries(headers.map((h, i) => [h, values[i] || ""]));
  });
  const result = await api("/api/instance/contacts/import", { method: "POST", body: { contacts } });
  alert(`Imported ${result.imported} contacts.`);
  await refreshContacts();
});

$("#scanTrackingBtn").addEventListener("click", async () => {
  if (!("BarcodeDetector" in window)) {
    alert("Barcode scanning is not supported in this browser yet. Use the tracking field manually.");
    return;
  }
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999;display:grid;place-items:center;padding:20px";
  overlay.innerHTML = `<div style="background:white;border-radius:10px;padding:16px;max-width:520px;width:100%">
    <h2>Scan Tracking Barcode</h2>
    <video autoplay playsinline style="width:100%;border-radius:8px;background:#111"></video>
    <div class="toolbar" style="margin-top:12px"><button id="closeScanner">Cancel</button></div>
  </div>`;
  document.body.appendChild(overlay);
  const video = overlay.querySelector("video");
  const detector = new BarcodeDetector();
  let stopped = false;
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  video.srcObject = stream;
  overlay.querySelector("#closeScanner").onclick = () => {
    stopped = true;
    stream.getTracks().forEach(track => track.stop());
    overlay.remove();
  };
  const scan = async () => {
    if (stopped) return;
    try {
      const codes = await detector.detect(video);
      if (codes.length) {
        document.querySelector('#packageForm [name="trackingNumber"]').value = codes[0].rawValue;
        overlay.querySelector("#closeScanner").click();
        return;
      }
    } catch {}
    requestAnimationFrame(scan);
  };
  scan();
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
$("#printItemizedBtn").addEventListener("click", () => {
  const selected = allPackages.filter(pkg => selectedPackages.has(pkg.id));
  if (!selected.length) return;
  const billedTo = selected[0].recipient_name;
  const total = selected.reduce((sum, pkg) => sum + Number(pkg.calculated_cost || 0), 0);
  const html = `<!doctype html><html><head><title>Itemized Parcel Receipt</title><style>
    body{font-family:Arial,sans-serif;color:#182230;margin:40px}
    .header{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #182230;padding-bottom:18px}
    h1{margin:0;font-size:30px;text-transform:uppercase}.muted{color:#667085}.bill{margin:24px 0;padding:16px;background:#f5f7fb;border-radius:8px}
    table{width:100%;border-collapse:collapse}th,td{padding:12px;border-bottom:1px solid #d7dde8;text-align:left}th{text-transform:uppercase;font-size:12px;color:#667085}.num{text-align:right}
    .total{text-align:right;font-size:24px;font-weight:800;margin-top:20px}
  </style></head><body>
    <div class="header"><div><h1>Itemized Parcel Receipt</h1><div class="muted">${meta.invoiceBusinessName || meta.name}</div></div><div class="muted">${new Date().toLocaleDateString()}</div></div>
    <div class="bill"><strong>Billing to</strong><br>${billedTo}</div>
    <table><thead><tr><th>Tracking</th><th class="num">Weight</th><th class="num">Cost</th></tr></thead><tbody>
      ${selected.map(pkg => `<tr><td>${pkg.tracking_number}</td><td class="num">${pkg.weight} lb</td><td class="num">$${Number(pkg.calculated_cost || 0).toFixed(2)}</td></tr>`).join("")}
    </tbody></table>
    <div class="total">Total: $${total.toFixed(2)}</div>
  </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
  w.print();
});

$("#runReportsBtn").addEventListener("click", refreshReports);
$("#printManifestBtn").addEventListener("click", () => {
  if (!reportData) return;
  const rows = reportData.undelivered;
  const html = `<!doctype html><html><head><title>Delivery Manifest</title><style>body{font-family:Arial;margin:36px}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ccc;padding:8px;text-align:left}h1{margin-bottom:4px}.muted{color:#666}</style></head><body><h1>Delivery Manifest</h1><p class="muted">${meta.name} | ${new Date().toLocaleDateString()}</p><table><thead><tr><th>Tracking</th><th>Recipient</th><th>Status</th><th>Received</th><th>Signature</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r.tracking_number}</td><td>${r.recipient_name}</td><td>${r.status}</td><td>${new Date(r.created_at).toLocaleDateString()}</td><td></td></tr>`).join("")}</tbody></table></body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
  w.print();
});
$("#exportPackagesBtn").addEventListener("click", () => {
  if (!reportData) return;
  const csv = [
    ["tracking", "recipient", "weight", "status", "received", "routed", "stored", "attempted", "delivered", "picked_up_by"].map(csvEscape).join(","),
    ...reportData.packages.map(r => [r.tracking_number, r.recipient_name, r.weight, r.status, r.created_at, r.routed_at, r.stored_at, r.attempted_at, r.delivered_at, r.picked_up_by_last_name].map(csvEscape).join(",")),
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "tracklet-packages.csv";
  a.click();
  URL.revokeObjectURL(url);
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
$("#reportFrom").value = today();
$("#reportTo").value = today();
addInvoiceItem();
boot();
