const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const proxyBase = location.pathname.match(/^\/x\/[^/]+/)?.[0] || "";
let me = null;
let meta = null;

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

function packageTable(pkgs) {
  return table(pkgs, [
    { label: "Tracking", key: "tracking_number" },
    { label: "Recipient", key: "recipient_name" },
    { label: "Storage", render: r => r.storage_name || "-" },
    { label: "Weight", render: r => `${r.weight} lb` },
    { label: "Cost", render: r => `$${Number(r.calculated_cost || 0).toFixed(2)}` },
    { label: "Status", render: r => r.is_delivered ? `<span class="badge ok">Delivered: ${r.picked_up_by_last_name || ""}</span>` : `<span class="badge warn">Pending</span>` },
    { label: "Actions", render: r => r.is_delivered ? "" : `<button onclick="deliver('${r.id}')">Deliver</button>` },
  ]);
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

async function refreshPackages() {
  const q = encodeURIComponent($("#packageSearch").value || "");
  const pkgs = await api(`/api/instance/packages?q=${q}`);
  $("#packageTable").innerHTML = packageTable(pkgs);
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
  $("#invoiceTable").innerHTML = table(rows, [
    { label: "Number", key: "invoice_number" },
    { label: "Billed To", key: "billed_to" },
    { label: "Due", key: "due_date" },
    { label: "Total", render: r => `$${r.total}` },
    { label: "Status", render: r => `<span class="badge ${r.status === "paid" ? "ok" : r.status === "voided" ? "danger" : "warn"}">${r.status}</span>` },
    { label: "Actions", render: r => `<div class="row-actions">
      <button onclick="invoiceStatus('${r.id}','${r.status === "paid" ? "unpaid" : "paid"}')">${r.status === "paid" ? "Mark Unpaid" : "Mark Paid"}</button>
      <button class="danger" onclick="invoiceStatus('${r.id}','voided')">Void</button>
      <button onclick='printInvoice(${JSON.stringify(r).replaceAll("'", "&apos;")})'>Print</button>
    </div>` },
  ]);
}

window.invoiceStatus = async (id, status) => {
  await api(`/api/instance/invoices/${id}`, { method: "PATCH", body: { status } });
  await refreshInvoices();
};

window.printInvoice = (inv) => {
  const html = `<h1>${inv.status === "paid" ? "RECEIPT" : inv.status === "voided" ? "VOIDED" : "INVOICE"} ${inv.invoice_number}</h1>
    <p><strong>Billed to:</strong><br>${String(inv.billed_to).replaceAll("\n", "<br>")}</p>
    <p><strong>Due:</strong> ${inv.due_date}</p>
    <table>${inv.items.map(i => `<tr><td>${i.name}</td><td>${i.quantity}</td><td>$${i.unit_price}</td><td>$${i.total}</td></tr>`).join("")}</table>
    <h2>Total: $${inv.total}</h2>`;
  const w = window.open("", "_blank");
  w.document.write(html);
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

$("#packageRefresh").addEventListener("click", refreshPackages);
$("#packageSearch").addEventListener("keydown", e => { if (e.key === "Enter") refreshPackages(); });
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
