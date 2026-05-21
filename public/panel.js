let overview = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(url, options = {}) {
  const res = await fetch(url, {
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

async function refresh() {
  overview = await api("/api/panel/overview");
  $("#statInstances").textContent = overview.instances.length;
  $("#statNodes").textContent = overview.nodes.length;
  $("#statPackages").textContent = overview.packageCount;
  $("#statTickets").textContent = overview.openTicketCount;
  $("#nodeSelect").innerHTML = overview.nodes.map(n => `<option value="${n.id}">${n.name}</option>`).join("");
  const instanceCols = [
    { label: "Name", render: r => `<strong>${r.name}</strong><br><span class="muted">${r.slug}</span>` },
    { label: "Node", key: "node_id" },
    { label: "Status", render: r => `<span class="badge ${r.status === "running" ? "ok" : "warn"}">${r.status}</span>${r.is_suspended ? ` <span class="badge danger">suspended</span>` : ""}` },
    { label: "Version", key: "version" },
    { label: "Actions", render: r => `<div class="row-actions">
      <a class="button primary" href="/x/${r.slug}/" target="_blank">Open</a>
      <button onclick="act('${r.id}','restart')">Restart</button>
      <button onclick="act('${r.id}','stop')">Stop</button>
      <button onclick="act('${r.id}','start')">Start</button>
      <button onclick="act('${r.id}','${r.is_suspended ? "unsuspend" : "suspend"}')">${r.is_suspended ? "Unsuspend" : "Suspend"}</button>
      <button class="danger" onclick="act('${r.id}','destroy')">Destroy</button>
    </div>` },
  ];
  $("#instanceTable").innerHTML = table(overview.instances, instanceCols);
  $("#recentInstances").innerHTML = table(overview.instances.slice(0, 5), instanceCols.slice(0, 4));
  $("#nodeTable").innerHTML = table(overview.nodes, [
    { label: "Name", render: r => `<strong>${r.name}</strong><br><span class="muted">${r.id}</span>` },
    { label: "Base URL", key: "base_url" },
    { label: "Status", render: r => `<span class="badge ${r.status === "online" ? "ok" : "warn"}">${r.status}</span>` },
    { label: "Last Seen", render: r => r.last_seen_at ? new Date(r.last_seen_at).toLocaleString() : "-" },
  ]);
  const tickets = await api("/api/panel/tickets");
  $("#ticketTable").innerHTML = table(tickets, [
    { label: "Subject", key: "subject" },
    { label: "Instance", key: "instance_name" },
    { label: "Status", render: r => `<span class="badge">${r.status}</span>` },
    { label: "Updated", render: r => new Date(r.updated_at).toLocaleString() },
  ]);
}

function addPricingTier(minWeight = "", maxWeight = "", price = "") {
  const row = document.createElement("div");
  row.className = "inline pricing-tier";
  row.innerHTML = `<label>Min weight <input name="tierMin" type="number" step="0.01" value="${minWeight}" /></label>
    <label>Max weight <input name="tierMax" type="number" step="0.01" value="${maxWeight}" /></label>
    <label>Price <input name="tierPrice" type="number" step="0.01" value="${price}" /></label>
    <button type="button" onclick="this.parentElement.remove()">Remove</button>`;
  $("#pricingTiers").appendChild(row);
}

function syncPricingMode() {
  const enabled = $("#instanceForm [name=pricingEnabled]").value === "true";
  const range = $("#pricingType").value === "range_based";
  $("#pricingType").disabled = !enabled;
  $("#perPoundWrap").classList.toggle("hidden", !enabled || range);
  $("#pricingTierWrap").classList.toggle("hidden", !enabled || !range);
}

window.act = async (id, action) => {
  if (action === "destroy" && !confirm("Destroy this instance container? Data remains until you delete it from the database manually.")) return;
  await api(`/api/panel/instances/${id}/action`, { method: "POST", body: { action } });
  await refresh();
};

async function boot() {
  const me = await api("/api/panel/me");
  $("#login").classList.toggle("hidden", !!me);
  $("#app").classList.toggle("hidden", !me);
  if (me) await refresh();
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    await api("/api/panel/login", { method: "POST", body });
    await boot();
  } catch {
    $("#loginError").textContent = "Invalid email or password.";
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/panel/logout", { method: "POST" });
  location.reload();
});

$$(".nav button").forEach(btn => btn.addEventListener("click", () => {
  $$(".nav button").forEach(b => b.classList.remove("active"));
  $$(".section").forEach(s => s.classList.remove("active"));
  btn.classList.add("active");
  $("#" + btn.dataset.view).classList.add("active");
}));

$("#nodeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/panel/nodes", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
  e.target.reset();
  await refresh();
});

$("#instanceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd);
  body.pricingEnabled = body.pricingEnabled === "true";
  body.invoiceEnabled = body.invoiceEnabled === "true";
  body.pricingTiers = fd.getAll("tierMin").map((minWeight, index) => ({
    minWeight,
    maxWeight: fd.getAll("tierMax")[index],
    price: fd.getAll("tierPrice")[index],
  }));
  $("#instanceCreateResult").textContent = "Provisioning container...";
  try {
    const result = await api("/api/panel/instances", { method: "POST", body });
    $("#instanceCreateResult").innerHTML = `Created. Login: <strong>${body.adminEmail}</strong> / <strong>${body.adminPassword}</strong>`;
    await refresh();
  } catch (err) {
    $("#instanceCreateResult").textContent = err.message;
  }
});

$("#instanceForm [name=pricingEnabled]").addEventListener("change", syncPricingMode);
$("#pricingType").addEventListener("change", syncPricingMode);
$("#addPricingTier").addEventListener("click", () => addPricingTier());

$("#archiveForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const result = await api("/api/panel/archive", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
  $("#archiveResult").textContent = `Archived ${result.archivedCount} packages.`;
});

boot().catch(() => {
  $("#login").classList.remove("hidden");
});

addPricingTier("1", "10", "5");
addPricingTier("11", "20", "10");
syncPricingMode();
