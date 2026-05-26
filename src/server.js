import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { nanoid } from "nanoid";
import { migrate, ensureLocalWing, query, one, many } from "./db.js";
import {
  sessionMiddleware,
  requirePanel,
  requireInstance,
  requireInstanceManager,
  verifyPassword,
  hashPassword,
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const mode = process.env.MODE || "panel";
const port = Number(process.env.PORT || 8080);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(sessionMiddleware());
app.use("/assets", express.static(path.join(root, "public")));

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48) || nanoid(8);
}

function cents(n) {
  return Number.parseFloat(n || 0).toFixed(2);
}

function labelCode() {
  return `TL-${nanoid(10).toUpperCase()}`;
}

async function instanceByEnv() {
  const id = process.env.INSTANCE_ID;
  if (!id) throw new Error("INSTANCE_ID is required in instance mode");
  const inst = await one(`SELECT * FROM instances WHERE id = $1`, [id]);
  if (!inst) throw new Error(`Instance ${id} not found`);
  return inst;
}

async function calculateCost(instanceId, weight) {
  const inst = await one(`SELECT * FROM instances WHERE id = $1`, [instanceId]);
  if (!inst?.pricing_enabled) return 0;
  if (inst.pricing_type === "per_pound") return Number(weight) * Number(inst.per_pound_rate || 0);
  const tier = await one(
    `SELECT * FROM pricing_tiers WHERE instance_id = $1 AND $2 BETWEEN min_weight AND max_weight ORDER BY max_weight LIMIT 1`,
    [instanceId, weight],
  );
  if (tier) return Number(tier.price);
  const top = await one(`SELECT * FROM pricing_tiers WHERE instance_id = $1 ORDER BY max_weight DESC LIMIT 1`, [instanceId]);
  return top ? Number(top.price) : 0;
}

async function logNotification(instanceId, event, pkg) {
  const template = await one(
    `SELECT * FROM notification_templates WHERE instance_id = $1 AND event = $2 AND enabled = true`,
    [instanceId, event],
  );
  if (!template) return;
  const contact = pkg.contact_id ? await one(`SELECT * FROM contacts WHERE id = $1 AND instance_id = $2`, [pkg.contact_id, instanceId]) : null;
  const recipient = contact?.email || null;
  const vars = {
    recipient: pkg.recipient_name,
    tracking: pkg.tracking_number,
    location: pkg.storage_name || "",
    status: pkg.status || event,
  };
  const render = (text) => String(text).replace(/\{\{(\w+)\}\}/g, (_m, key) => vars[key] ?? "");
  await query(
    `INSERT INTO notification_logs (instance_id, package_id, contact_id, event, recipient, subject, body, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [instanceId, pkg.id, pkg.contact_id || null, event, recipient, render(template.subject), render(template.body), recipient ? "queued" : "missing_recipient"],
  );
}

async function dockerRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        socketPath: "/var/run/docker.sock",
        path: apiPath,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400) return reject(new Error(data || `Docker ${res.statusCode}`));
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch {
            resolve(data);
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function mountPanel() {
  app.get("/", (_req, res) => res.sendFile(path.join(root, "public", "panel.html")));

  app.post("/api/panel/login", async (req, res) => {
    const user = await one(`SELECT * FROM panel_users WHERE lower(email) = lower($1)`, [req.body.email]);
    if (!user || !(await verifyPassword(req.body.password || "", user.password_hash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    req.session.panelUser = { id: user.id, email: user.email, name: user.name, role: user.role };
    res.json(req.session.panelUser);
  });

  app.post("/api/panel/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get("/api/panel/me", (req, res) => res.json(req.session.panelUser || null));

  app.get("/api/panel/overview", requirePanel, async (_req, res) => {
    const [nodes, instances, packages, tickets] = await Promise.all([
      many(`SELECT * FROM nodes ORDER BY created_at DESC`),
      many(`SELECT * FROM instances ORDER BY created_at DESC`),
      one(`SELECT count(*)::int AS count FROM packages`),
      one(`SELECT count(*)::int AS count FROM tickets WHERE status <> 'closed'`),
    ]);
    res.json({ nodes, instances, packageCount: packages.count, openTicketCount: tickets.count });
  });

  app.post("/api/panel/nodes", requirePanel, async (req, res) => {
    const id = req.body.id || slugify(req.body.name || "wing");
    const token = req.body.token || nanoid(40);
    const node = await one(
      `INSERT INTO nodes (id, name, base_url, token) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, base_url = EXCLUDED.base_url, token = EXCLUDED.token
       RETURNING *`,
      [id, req.body.name, req.body.baseUrl || `http://${id}:8080`, token],
    );
    res.json(node);
  });

  app.post("/api/panel/instances", requirePanel, async (req, res) => {
    const slug = slugify(req.body.slug || req.body.name);
    const node = await one(`SELECT * FROM nodes WHERE id = $1`, [req.body.nodeId]);
    if (!node) return res.status(400).json({ error: "Node not found" });
    const inst = await one(
      `INSERT INTO instances (slug, name, node_id, image, version, pricing_enabled, pricing_type, per_pound_rate, invoice_enabled, invoice_business_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        slug,
        req.body.name,
        node.id,
        req.body.image || "trackletv2-platform-app:latest",
        req.body.version || "latest",
        !!req.body.pricingEnabled,
        req.body.pricingType || "per_pound",
        req.body.perPoundRate || null,
        req.body.invoiceEnabled !== false,
        req.body.invoiceBusinessName || req.body.name,
      ],
    );
    if (req.body.pricingTiers && Array.isArray(req.body.pricingTiers)) {
      for (const tier of req.body.pricingTiers) {
        if (tier.minWeight !== "" && tier.maxWeight !== "" && tier.price !== "") {
          await query(
            `INSERT INTO pricing_tiers (instance_id, min_weight, max_weight, price) VALUES ($1,$2,$3,$4)`,
            [inst.id, tier.minWeight, tier.maxWeight, tier.price],
          );
        }
      }
    }
    const adminPassword = req.body.adminPassword || "ChangeMe123!";
    await query(
      `INSERT INTO instance_users (instance_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, 'admin')`,
      [inst.id, req.body.adminEmail || `admin@${slug}.local`, await hashPassword(adminPassword), "Location Admin"],
    );
    try {
      const wingRes = await fetch(`${node.base_url}/wing/instances`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${node.token}` },
        body: JSON.stringify(inst),
      });
      if (!wingRes.ok) throw new Error(await wingRes.text());
      const created = await wingRes.json();
      const updated = await one(
        `UPDATE instances SET container_name = $2, internal_url = $3, status = 'running' WHERE id = $1 RETURNING *`,
        [inst.id, created.containerName, created.internalUrl],
      );
      return res.json({ instance: updated, adminEmail: req.body.adminEmail, adminPassword });
    } catch (error) {
      await query(`UPDATE instances SET status = 'provision_error' WHERE id = $1`, [inst.id]);
      return res.status(502).json({ error: `Wing provisioning failed: ${error.message}`, instance: inst });
    }
  });

  app.post("/api/panel/instances/:id/action", requirePanel, async (req, res) => {
    const inst = await one(`SELECT i.*, n.base_url, n.token FROM instances i LEFT JOIN nodes n ON n.id = i.node_id WHERE i.id = $1`, [req.params.id]);
    if (!inst) return res.status(404).json({ error: "Instance not found" });
    if (req.body.action === "suspend") {
      await query(`UPDATE instances SET is_suspended = true WHERE id = $1`, [inst.id]);
      return res.json({ ok: true });
    }
    if (req.body.action === "unsuspend") {
      await query(`UPDATE instances SET is_suspended = false WHERE id = $1`, [inst.id]);
      return res.json({ ok: true });
    }
    if (req.body.action === "rebuild") {
      const wingRes = await fetch(`${inst.base_url}/wing/instances`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${inst.token}` },
        body: JSON.stringify(inst),
      });
      if (!wingRes.ok) return res.status(502).send(await wingRes.text());
      const rebuilt = await wingRes.json();
      const updated = await one(
        `UPDATE instances SET container_name = $2, internal_url = $3, status = 'running' WHERE id = $1 RETURNING *`,
        [inst.id, rebuilt.containerName, rebuilt.internalUrl],
      );
      return res.json({ ok: true, instance: updated });
    }
    const wingRes = await fetch(`${inst.base_url}/wing/instances/${inst.id}/${req.body.action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${inst.token}` },
    });
    if (!wingRes.ok) return res.status(502).send(await wingRes.text());
    const nextStatus = req.body.action === "destroy" ? "destroyed" : req.body.action === "stop" ? "stopped" : "running";
    await query(`UPDATE instances SET status = $2 WHERE id = $1`, [inst.id, nextStatus]);
    res.json({ ok: true });
  });

  app.get("/api/panel/instances/:id/users", requirePanel, async (req, res) => {
    res.json(await many(`SELECT id, email, name, role, is_active, created_at FROM instance_users WHERE instance_id = $1 ORDER BY created_at`, [req.params.id]));
  });

  app.post("/api/panel/instances/:id/users", requirePanel, async (req, res) => {
    const user = await one(
      `INSERT INTO instance_users (instance_id, email, password_hash, name, role)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, role, is_active`,
      [req.params.id, req.body.email, await hashPassword(req.body.password), req.body.name || null, req.body.role || "employee"],
    );
    res.json(user);
  });

  app.get("/api/panel/tickets", requirePanel, async (_req, res) => {
    res.json(await many(
      `SELECT t.*, i.name AS instance_name FROM tickets t JOIN instances i ON i.id = t.instance_id ORDER BY t.updated_at DESC`,
    ));
  });

  app.post("/api/panel/archive", requirePanel, async (req, res) => {
    const months = Number(req.body.monthsOld || 2);
    const result = await query(
      `WITH moved AS (
        DELETE FROM packages
        WHERE is_delivered = true AND delivered_at < now() - ($1 || ' months')::interval
        RETURNING instance_id, tracking_number, recipient_name, picked_up_by_last_name, delivered_at
      )
      INSERT INTO archived_packages (instance_id, tracking_number, recipient_name, picked_up_by_last_name, delivered_at)
      SELECT instance_id, tracking_number, recipient_name, picked_up_by_last_name, delivered_at FROM moved
      RETURNING id`,
      [months],
    );
    res.json({ archivedCount: result.rowCount });
  });

  app.use(
    "/x/:slug",
    createProxyMiddleware({
      target: "http://placeholder",
      changeOrigin: true,
      on: {
        proxyReq: fixRequestBody,
      },
      router: async (req) => {
        const slug = req.params?.slug || req.url.split("/")[1];
        const inst = await one(`SELECT internal_url FROM instances WHERE slug = $1 AND status <> 'destroyed'`, [slug]);
        return inst?.internal_url || "http://127.0.0.1:9";
      },
      pathRewrite: (path) => path.replace(/^\/x\/[^/]+/, "") || "/",
    }),
  );
}

function mountWing() {
  function requireWing(req, res, next) {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (token && token === process.env.WING_TOKEN) return next();
    res.status(401).json({ error: "Invalid wing token" });
  }

  app.get("/wing/health", (_req, res) => res.json({ ok: true, wingId: process.env.WING_ID || "wing-local" }));

  app.post("/wing/instances", requireWing, async (req, res) => {
    const inst = req.body;
    const containerName = `trackletv2-inst-${inst.slug}`;
    const networkName = process.env.DOCKER_NETWORK || "trackletv2-platform-net";
    const env = [
      `MODE=instance`,
      `PORT=8080`,
      `DATABASE_URL=${process.env.DATABASE_URL}`,
      `SESSION_SECRET=${process.env.SESSION_SECRET || "tracklet-dev-secret"}`,
      `INSTANCE_ID=${inst.id}`,
    ];
    try {
      await dockerRequest("POST", `/containers/${containerName}/stop`).catch(() => {});
      await dockerRequest("DELETE", `/containers/${containerName}?force=true`).catch(() => {});
      await dockerRequest("POST", `/containers/create?name=${containerName}`, {
        Image: process.env.INSTANCE_IMAGE || inst.image || "trackletv2-platform-app:latest",
        Env: env,
        ExposedPorts: { "8080/tcp": {} },
        HostConfig: {
          RestartPolicy: { Name: "unless-stopped" },
          NetworkMode: networkName,
        },
      });
      await dockerRequest("POST", `/containers/${containerName}/start`);
      res.json({ containerName, internalUrl: `http://${containerName}:8080` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  for (const action of ["start", "stop", "restart", "destroy"]) {
    app.post(`/wing/instances/:id/${action}`, requireWing, async (req, res) => {
      const inst = await one(`SELECT * FROM instances WHERE id = $1`, [req.params.id]);
      if (!inst?.container_name) return res.status(404).json({ error: "Container not found" });
      try {
        if (action === "destroy") await dockerRequest("DELETE", `/containers/${inst.container_name}?force=true`);
        else await dockerRequest("POST", `/containers/${inst.container_name}/${action}`);
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }
}

function mountInstance() {
  app.get("/", (_req, res) => res.sendFile(path.join(root, "public", "instance.html")));

  app.get("/api/instance/meta", async (_req, res) => {
    const inst = await instanceByEnv();
    res.json({
      id: inst.id,
      slug: inst.slug,
      name: inst.name,
      invoiceEnabled: inst.invoice_enabled,
      invoiceBusinessName: inst.invoice_business_name,
      invoiceLogo: inst.invoice_logo,
      pricingEnabled: inst.pricing_enabled,
      isSuspended: inst.is_suspended,
      user: app.locals.lastUser || null,
    });
  });

  app.post("/api/instance/login", async (req, res) => {
    const inst = await instanceByEnv();
    if (inst.is_suspended) return res.status(403).json({ error: "This location is suspended" });
    const user = await one(
      `SELECT * FROM instance_users WHERE instance_id = $1 AND lower(email) = lower($2) AND is_active = true`,
      [inst.id, req.body.email],
    );
    if (!user || !(await verifyPassword(req.body.password || "", user.password_hash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    req.session.instanceUser = { id: user.id, instanceId: inst.id, email: user.email, name: user.name, role: user.role };
    res.json(req.session.instanceUser);
  });

  app.post("/api/instance/logout", (req, res) => {
    delete req.session.instanceUser;
    res.json({ ok: true });
  });

  app.patch("/api/instance/settings", requireInstanceManager, async (req, res) => {
    const updated = await one(
      `UPDATE instances
       SET invoice_logo = COALESCE($2, invoice_logo),
           invoice_business_name = COALESCE($3, invoice_business_name)
       WHERE id = $1
       RETURNING id, name, invoice_business_name, invoice_logo`,
      [
        req.session.instanceUser.instanceId,
        req.body.invoiceLogo === undefined ? null : req.body.invoiceLogo,
        req.body.invoiceBusinessName === undefined ? null : req.body.invoiceBusinessName,
      ],
    );
    res.json(updated);
  });

  app.get("/api/instance/me", (req, res) => res.json(req.session.instanceUser || null));

  app.get("/api/instance/dashboard", requireInstance, async (req, res) => {
    const instanceId = req.session.instanceUser.instanceId;
    const [packages, pending, value, tickets, invoices] = await Promise.all([
      one(`SELECT count(*)::int AS count FROM packages WHERE instance_id = $1`, [instanceId]),
      one(`SELECT count(*)::int AS count FROM packages WHERE instance_id = $1 AND is_delivered = false`, [instanceId]),
      many(`SELECT weight FROM packages WHERE instance_id = $1 AND is_delivered = false`, [instanceId]),
      one(`SELECT count(*)::int AS count FROM tickets WHERE instance_id = $1 AND status <> 'closed'`, [instanceId]),
      one(`SELECT count(*)::int AS count FROM invoices WHERE instance_id = $1`, [instanceId]),
    ]);
    let totalValue = 0;
    for (const row of value) totalValue += await calculateCost(instanceId, row.weight);
    res.json({ totalPackages: packages.count, pendingPackages: pending.count, totalValue, openTickets: tickets.count, invoices: invoices.count });
  });

  app.get("/api/instance/storage", requireInstance, async (req, res) => {
    res.json(await many(`SELECT * FROM storage_locations WHERE instance_id = $1 ORDER BY name`, [req.session.instanceUser.instanceId]));
  });

  app.get("/api/instance/contacts", requireInstance, async (req, res) => {
    const q = `%${req.query.q || ""}%`;
    res.json(await many(
      `SELECT * FROM contacts
       WHERE instance_id = $1
         AND ($2 = '%%' OR first_name ILIKE $2 OR last_name ILIKE $2 OR email ILIKE $2 OR contact_code ILIKE $2 OR mailbox ILIKE $2)
       ORDER BY last_name, first_name LIMIT 1000`,
      [req.session.instanceUser.instanceId, q],
    ));
  });

  app.post("/api/instance/contacts", requireInstanceManager, async (req, res) => {
    const c = await one(
      `INSERT INTO contacts (instance_id, first_name, last_name, email, contact_code, mailbox, phone, department, building, forward_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        req.session.instanceUser.instanceId,
        req.body.firstName || null,
        req.body.lastName,
        req.body.email || null,
        req.body.contactCode || null,
        req.body.mailbox || null,
        req.body.phone || null,
        req.body.department || null,
        req.body.building || null,
        req.body.forwardAddress || null,
      ],
    );
    res.json(c);
  });

  app.post("/api/instance/contacts/import", requireInstanceManager, async (req, res) => {
    const rows = Array.isArray(req.body.contacts) ? req.body.contacts : [];
    let imported = 0;
    for (const row of rows) {
      if (!row.lastName) continue;
      await query(
        `INSERT INTO contacts (instance_id, first_name, last_name, email, contact_code, mailbox, phone, department, building, forward_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.session.instanceUser.instanceId, row.firstName || null, row.lastName, row.email || null, row.contactCode || null, row.mailbox || null, row.phone || null, row.department || null, row.building || null, row.forwardAddress || null],
      );
      imported++;
    }
    res.json({ imported });
  });

  app.post("/api/instance/storage", requireInstanceManager, async (req, res) => {
    res.json(await one(`INSERT INTO storage_locations (instance_id, name) VALUES ($1,$2) RETURNING *`, [req.session.instanceUser.instanceId, req.body.name]));
  });

  app.delete("/api/instance/storage/:id", requireInstanceManager, async (req, res) => {
    await query(`DELETE FROM storage_locations WHERE id = $1 AND instance_id = $2`, [req.params.id, req.session.instanceUser.instanceId]);
    res.json({ ok: true });
  });

  app.get("/api/instance/notifications", requireInstanceManager, async (req, res) => {
    const instanceId = req.session.instanceUser.instanceId;
    const defaults = [
      ["received", "Package received for {{recipient}}", "Your package {{tracking}} has been received."],
      ["routed", "Package routed for {{recipient}}", "Your package {{tracking}} has been routed. {{location}}"],
      ["stored", "Package stored for {{recipient}}", "Your package {{tracking}} is ready for pickup. {{location}}"],
      ["attempted", "Delivery attempted for {{recipient}}", "We attempted delivery for package {{tracking}}."],
      ["delivered", "Package delivered for {{recipient}}", "Your package {{tracking}} has been delivered."],
    ];
    for (const [event, subject, body] of defaults) {
      await query(
        `INSERT INTO notification_templates (instance_id, event, subject, body)
         VALUES ($1,$2,$3,$4) ON CONFLICT (instance_id, event) DO NOTHING`,
        [instanceId, event, subject, body],
      );
    }
    const templates = await many(`SELECT * FROM notification_templates WHERE instance_id = $1 ORDER BY event`, [instanceId]);
    const logs = await many(`SELECT * FROM notification_logs WHERE instance_id = $1 ORDER BY created_at DESC LIMIT 100`, [instanceId]);
    res.json({ templates, logs });
  });

  app.patch("/api/instance/notifications/:id", requireInstanceManager, async (req, res) => {
    res.json(await one(
      `UPDATE notification_templates
       SET enabled = COALESCE($3, enabled), subject = COALESCE($4, subject), body = COALESCE($5, body), delay_hours = COALESCE($6, delay_hours)
       WHERE id = $1 AND instance_id = $2 RETURNING *`,
      [req.params.id, req.session.instanceUser.instanceId, req.body.enabled, req.body.subject || null, req.body.body || null, req.body.delayHours ?? null],
    ));
  });

  app.get("/api/instance/packages", requireInstance, async (req, res) => {
    const instanceId = req.session.instanceUser.instanceId;
    const search = `%${req.query.q || ""}%`;
    const rows = await many(
      `SELECT p.*, s.name AS storage_name, u.name AS created_by_name, u.email AS created_by_email,
              c.email AS contact_email, c.mailbox AS contact_mailbox, c.department AS contact_department, c.building AS contact_building
       FROM packages p
       LEFT JOIN storage_locations s ON s.id = p.storage_location_id
       LEFT JOIN instance_users u ON u.id = p.created_by
       LEFT JOIN contacts c ON c.id = p.contact_id
       WHERE p.instance_id = $1 AND ($2 = '%%' OR p.recipient_name ILIKE $2 OR p.tracking_number ILIKE $2)
       ORDER BY p.created_at DESC LIMIT 500`,
      [instanceId, search],
    );
    for (const row of rows) row.calculated_cost = await calculateCost(instanceId, row.weight);
    res.json(rows);
  });

  app.post("/api/instance/packages", requireInstance, async (req, res) => {
    const pkg = await one(
      `INSERT INTO packages (instance_id, tracking_number, recipient_name, contact_id, weight, storage_location_id, notes, created_by, status, label_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received',$9) RETURNING *`,
      [req.session.instanceUser.instanceId, req.body.trackingNumber, req.body.recipientName, req.body.contactId || null, req.body.weight, req.body.storageLocationId || null, req.body.notes || null, req.session.instanceUser.id, labelCode()],
    );
    await logNotification(req.session.instanceUser.instanceId, "received", pkg);
    res.json(pkg);
  });

  app.patch("/api/instance/packages/:id", requireInstance, async (req, res) => {
    const nextStatus = req.body.status || (req.body.isDelivered ? "delivered" : null);
    const pkg = await one(
      `UPDATE packages SET
        recipient_name = COALESCE($3, recipient_name),
        status = COALESCE($4, status),
        is_delivered = CASE WHEN $4 = 'delivered' THEN true ELSE COALESCE($5, is_delivered) END,
        routed_at = CASE WHEN $4 = 'routed' AND routed_at IS NULL THEN now() ELSE routed_at END,
        stored_at = CASE WHEN $4 = 'stored' AND stored_at IS NULL THEN now() ELSE stored_at END,
        attempted_at = CASE WHEN $4 = 'attempted' THEN now() ELSE attempted_at END,
        delivered_at = CASE WHEN $4 = 'delivered' OR $5 = true THEN now() ELSE delivered_at END,
        delivery_notes = COALESCE($7, delivery_notes),
        delivery_signature = COALESCE($8, delivery_signature),
        delivery_photo = COALESCE($9, delivery_photo),
        id_verification = COALESCE($10, id_verification),
        picked_up_by_last_name = COALESCE($6, picked_up_by_last_name)
       WHERE id = $1 AND instance_id = $2 RETURNING *`,
      [
        req.params.id,
        req.session.instanceUser.instanceId,
        req.body.recipientName || null,
        nextStatus,
        req.body.isDelivered,
        req.body.pickedUpByLastName || null,
        req.body.deliveryNotes || null,
        req.body.deliverySignature || null,
        req.body.deliveryPhoto || null,
        req.body.idVerification || null,
      ],
    );
    if (nextStatus) await logNotification(req.session.instanceUser.instanceId, nextStatus, pkg);
    res.json(pkg);
  });

  app.patch("/api/instance/packages/bulk", requireInstance, async (req, res) => {
    const ids = req.body.packageIds || [];
    for (const id of ids) {
      await query(
        `UPDATE packages SET
          recipient_name = COALESCE($3, recipient_name),
          status = CASE WHEN $4 = true THEN 'delivered' ELSE status END,
          is_delivered = COALESCE($4, is_delivered),
          picked_up_by_last_name = COALESCE($5, picked_up_by_last_name),
          delivered_at = CASE WHEN $4 = true THEN now() ELSE delivered_at END
         WHERE id = $1 AND instance_id = $2`,
        [id, req.session.instanceUser.instanceId, req.body.recipientName || null, req.body.isDelivered, req.body.pickedUpByLastName || null],
      );
    }
    res.json({ updated: ids.length });
  });

  app.get("/api/instance/archive/search", requireInstance, async (req, res) => {
    res.json(await many(
      `SELECT * FROM archived_packages WHERE instance_id = $1 AND (recipient_name ILIKE $2 OR tracking_number ILIKE $2) ORDER BY delivered_at DESC`,
      [req.session.instanceUser.instanceId, `%${req.query.q || ""}%`],
    ));
  });

  app.get("/api/instance/reports", requireInstance, async (req, res) => {
    const instanceId = req.session.instanceUser.instanceId;
    const from = req.query.from || "1970-01-01";
    const to = req.query.to || "2999-12-31";
    const summary = await many(
      `SELECT status, count(*)::int AS count FROM packages WHERE instance_id = $1 AND created_at::date BETWEEN $2 AND $3 GROUP BY status ORDER BY status`,
      [instanceId, from, to],
    );
    const packages = await many(
      `SELECT tracking_number, recipient_name, weight, status, created_at, routed_at, stored_at, attempted_at, delivered_at, picked_up_by_last_name
       FROM packages WHERE instance_id = $1 AND created_at::date BETWEEN $2 AND $3 ORDER BY created_at DESC LIMIT 2000`,
      [instanceId, from, to],
    );
    const undelivered = packages.filter(p => p.status !== "delivered");
    const stale = packages.filter(p => p.status !== "delivered" && (Date.now() - new Date(p.created_at).getTime()) > 7 * 24 * 60 * 60 * 1000);
    res.json({ summary, packages, undelivered, stale });
  });

  app.get("/api/instance/users", requireInstanceManager, async (req, res) => {
    res.json(await many(`SELECT id, email, name, role, is_active FROM instance_users WHERE instance_id = $1 ORDER BY created_at`, [req.session.instanceUser.instanceId]));
  });

  app.post("/api/instance/users", requireInstanceManager, async (req, res) => {
    const role = req.session.instanceUser.role === "manager" ? "employee" : req.body.role || "employee";
    res.json(await one(
      `INSERT INTO instance_users (instance_id, email, password_hash, name, role) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, email, name, role, is_active`,
      [req.session.instanceUser.instanceId, req.body.email, await hashPassword(req.body.password), req.body.name || null, role],
    ));
  });

  app.patch("/api/instance/users/:id", requireInstanceManager, async (req, res) => {
    res.json(await one(
      `UPDATE instance_users SET is_active = COALESCE($3, is_active), role = COALESCE($4, role)
       WHERE id = $1 AND instance_id = $2 RETURNING id, email, name, role, is_active`,
      [req.params.id, req.session.instanceUser.instanceId, req.body.isActive, req.body.role || null],
    ));
  });

  app.get("/api/instance/tickets", requireInstance, async (req, res) => {
    const where = req.session.instanceUser.role === "employee" ? `AND t.user_id = $2` : "";
    const params = req.session.instanceUser.role === "employee" ? [req.session.instanceUser.instanceId, req.session.instanceUser.id] : [req.session.instanceUser.instanceId];
    const tickets = await many(`SELECT t.*, u.name AS user_name FROM tickets t LEFT JOIN instance_users u ON u.id = t.user_id WHERE t.instance_id = $1 ${where} ORDER BY t.updated_at DESC`, params);
    for (const t of tickets) t.messages = await many(`SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at`, [t.id]);
    res.json(tickets);
  });

  app.post("/api/instance/tickets", requireInstance, async (req, res) => {
    const t = await one(
      `INSERT INTO tickets (instance_id, user_id, subject) VALUES ($1,$2,$3) RETURNING *`,
      [req.session.instanceUser.instanceId, req.session.instanceUser.id, req.body.subject],
    );
    await query(`INSERT INTO ticket_messages (ticket_id, sender_name, is_admin, message) VALUES ($1,$2,$3,$4)`, [t.id, req.session.instanceUser.name || req.session.instanceUser.email, false, req.body.message]);
    res.json(t);
  });

  app.post("/api/instance/tickets/:id/messages", requireInstance, async (req, res) => {
    const isAdmin = req.session.instanceUser.role !== "employee";
    const m = await one(
      `INSERT INTO ticket_messages (ticket_id, sender_name, is_admin, message) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.session.instanceUser.name || req.session.instanceUser.email, isAdmin, req.body.message],
    );
    await query(`UPDATE tickets SET status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END, updated_at = now() WHERE id = $1`, [req.params.id]);
    res.json(m);
  });

  app.patch("/api/instance/tickets/:id", requireInstanceManager, async (req, res) => {
    res.json(await one(`UPDATE tickets SET status = $3, updated_at = now() WHERE id = $1 AND instance_id = $2 RETURNING *`, [req.params.id, req.session.instanceUser.instanceId, req.body.status]));
  });

  app.get("/api/instance/invoices", requireInstance, async (req, res) => {
    const invoices = await many(`SELECT * FROM invoices WHERE instance_id = $1 ORDER BY created_at DESC`, [req.session.instanceUser.instanceId]);
    for (const inv of invoices) inv.items = await many(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [inv.id]);
    res.json(invoices);
  });

  app.post("/api/instance/invoices", requireInstance, async (req, res) => {
    const count = await one(`SELECT count(*)::int AS count FROM invoices WHERE instance_id = $1`, [req.session.instanceUser.instanceId]);
    const invoiceNumber = `INV-${String(count.count + 1).padStart(5, "0")}`;
    const items = req.body.items || [];
    const total = items.reduce((sum, item) => sum + Number(item.quantity || 1) * Number(item.unitPrice || 0), 0);
    const inv = await one(
      `INSERT INTO invoices (instance_id, invoice_number, billed_to, due_date, total, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.session.instanceUser.instanceId, invoiceNumber, req.body.billedTo, req.body.dueDate, cents(total), req.session.instanceUser.id],
    );
    for (const item of items) {
      const lineTotal = Number(item.quantity || 1) * Number(item.unitPrice || 0);
      await query(`INSERT INTO invoice_items (invoice_id, name, quantity, unit_price, total) VALUES ($1,$2,$3,$4,$5)`, [inv.id, item.name, item.quantity || 1, cents(item.unitPrice), cents(lineTotal)]);
    }
    res.json(inv);
  });

  app.patch("/api/instance/invoices/:id", requireInstance, async (req, res) => {
    const status = req.body.status === "voided" ? "voided" : req.body.status === "paid" ? "paid" : "unpaid";
    res.json(await one(
      `UPDATE invoices
       SET status = $3,
           paid_at = CASE
             WHEN $3 = 'paid' AND paid_at IS NULL THEN now()
             WHEN $3 = 'unpaid' THEN NULL
             ELSE paid_at
           END
       WHERE id = $1 AND instance_id = $2 AND status <> 'voided'
       RETURNING *`,
      [req.params.id, req.session.instanceUser.instanceId, status],
    ));
  });

  app.post("/api/instance/backups", requireInstanceManager, async (req, res) => {
    const instanceId = req.session.instanceUser.instanceId;
    const payload = {
      packages: await many(`SELECT * FROM packages WHERE instance_id = $1`, [instanceId]),
      storage: await many(`SELECT * FROM storage_locations WHERE instance_id = $1`, [instanceId]),
      users: await many(`SELECT id,email,name,role,is_active FROM instance_users WHERE instance_id = $1`, [instanceId]),
      invoices: await many(`SELECT * FROM invoices WHERE instance_id = $1`, [instanceId]),
      tickets: await many(`SELECT * FROM tickets WHERE instance_id = $1`, [instanceId]),
      createdAt: new Date().toISOString(),
    };
    const backup = await one(`INSERT INTO backups (instance_id, kind, payload) VALUES ($1, 'manual', $2) RETURNING id, created_at`, [instanceId, payload]);
    res.json(backup);
  });
}

await migrate();
await ensureLocalWing();

if (mode === "panel") mountPanel();
if (mode === "wing") mountWing();
if (mode === "instance") mountInstance();

app.listen(port, "0.0.0.0", () => {
  console.log(`Tracklet ${mode} listening on ${port}`);
});
