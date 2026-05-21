import pg from "pg";
import bcrypt from "bcryptjs";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result;
}

export async function one(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

export async function many(text, params = []) {
  const result = await query(text, params);
  return result.rows;
}

export async function migrate() {
  await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid varchar PRIMARY KEY,
      sess jsonb NOT NULL,
      expire timestamp NOT NULL
    );
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON sessions (expire);

    CREATE TABLE IF NOT EXISTS panel_users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      name text,
      role text NOT NULL DEFAULT 'admin',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id text PRIMARY KEY,
      name text NOT NULL,
      base_url text NOT NULL,
      token text NOT NULL,
      status text NOT NULL DEFAULT 'unknown',
      last_seen_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS instances (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text UNIQUE NOT NULL,
      name text NOT NULL,
      node_id text REFERENCES nodes(id) ON DELETE SET NULL,
      container_name text,
      image text NOT NULL DEFAULT 'tracklet-platform-app:latest',
      version text NOT NULL DEFAULT 'latest',
      status text NOT NULL DEFAULT 'created',
      internal_url text,
      pricing_enabled boolean NOT NULL DEFAULT false,
      pricing_type text NOT NULL DEFAULT 'per_pound',
      per_pound_rate numeric(10,2),
      invoice_enabled boolean NOT NULL DEFAULT true,
      invoice_business_name text,
      invoice_logo text,
      is_suspended boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS instance_users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      email text NOT NULL,
      password_hash text NOT NULL,
      name text,
      role text NOT NULL DEFAULT 'employee',
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(instance_id, email)
    );

    CREATE TABLE IF NOT EXISTS storage_locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS pricing_tiers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      min_weight numeric(10,2) NOT NULL,
      max_weight numeric(10,2) NOT NULL,
      price numeric(10,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS packages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      tracking_number text NOT NULL,
      recipient_name text NOT NULL,
      weight numeric(10,2) NOT NULL,
      storage_location_id uuid REFERENCES storage_locations(id) ON DELETE SET NULL,
      notes text,
      is_delivered boolean NOT NULL DEFAULT false,
      picked_up_by_last_name text,
      delivered_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS archived_packages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      tracking_number text NOT NULL,
      recipient_name text NOT NULL,
      picked_up_by_last_name text,
      delivered_at timestamptz NOT NULL,
      archived_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      user_id uuid REFERENCES instance_users(id) ON DELETE SET NULL,
      subject text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ticket_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      sender_name text NOT NULL,
      is_admin boolean NOT NULL DEFAULT false,
      message text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      invoice_number text NOT NULL,
      billed_to text NOT NULL,
      due_date date NOT NULL,
      status text NOT NULL DEFAULT 'unpaid',
      total numeric(10,2) NOT NULL DEFAULT 0,
      created_by uuid REFERENCES instance_users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(instance_id, invoice_number)
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      name text NOT NULL,
      quantity integer NOT NULL DEFAULT 1,
      unit_price numeric(10,2) NOT NULL,
      total numeric(10,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      kind text NOT NULL DEFAULT 'manual',
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const adminCount = await one(`SELECT count(*)::int AS count FROM panel_users`);
  if (adminCount.count === 0) {
    const email = process.env.DEFAULT_ADMIN_EMAIL || "admin@tracklet.local";
    const password = process.env.DEFAULT_ADMIN_PASSWORD || "ChangeMe123!";
    const passwordHash = await bcrypt.hash(password, 12);
    await query(
      `INSERT INTO panel_users (email, password_hash, name, role) VALUES ($1, $2, $3, 'admin')`,
      [email, passwordHash, "Tracklet Admin"],
    );
    console.log(`[migrate] Seeded initial panel admin: ${email}`);
  }
}

export async function ensureLocalWing() {
  if (process.env.MODE !== "wing") return;
  const id = process.env.WING_ID || "wing-local";
  const name = process.env.WING_NAME || "Local Wing";
  const token = process.env.WING_TOKEN || "change-this-wing-token";
  const baseUrl = process.env.WING_BASE_URL || "http://wing:8080";
  await query(
    `INSERT INTO nodes (id, name, base_url, token, status, last_seen_at)
     VALUES ($1, $2, $3, $4, 'online', now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, token = EXCLUDED.token, status = 'online', last_seen_at = now()`,
    [id, name, baseUrl, token],
  );
}
