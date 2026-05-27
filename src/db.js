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
      image text NOT NULL DEFAULT 'trackletv2-platform-app:latest',
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

    CREATE TABLE IF NOT EXISTS contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      first_name text,
      last_name text NOT NULL,
      email text,
      contact_code text,
      mailbox text,
      phone text,
      department text,
      building text,
      forward_address text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS packages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      tracking_number text NOT NULL,
      recipient_name text NOT NULL,
      contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
      weight numeric(10,2) NOT NULL,
      storage_location_id uuid REFERENCES storage_locations(id) ON DELETE SET NULL,
      notes text,
      created_by uuid REFERENCES instance_users(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'received',
      label_code text,
      routed_at timestamptz,
      stored_at timestamptz,
      attempted_at timestamptz,
      is_delivered boolean NOT NULL DEFAULT false,
      picked_up_by_last_name text,
      delivery_notes text,
      delivery_signature text,
      delivery_photo text,
      id_verification text,
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
      paid_at timestamptz,
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

    CREATE TABLE IF NOT EXISTS notification_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      event text NOT NULL,
      enabled boolean NOT NULL DEFAULT false,
      subject text NOT NULL,
      body text NOT NULL,
      delay_hours numeric(10,2) NOT NULL DEFAULT 0,
      UNIQUE(instance_id, event)
    );

    CREATE TABLE IF NOT EXISTS notification_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      package_id uuid REFERENCES packages(id) ON DELETE SET NULL,
      contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
      event text NOT NULL,
      recipient text,
      subject text,
      body text,
      status text NOT NULL DEFAULT 'queued',
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await query(`
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at timestamptz;
    ALTER TABLE instances ADD COLUMN IF NOT EXISTS invoice_logo text;
    ALTER TABLE instances ADD COLUMN IF NOT EXISTS invoice_business_name text;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES instance_users(id) ON DELETE SET NULL;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'received';
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS label_code text;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS routed_at timestamptz;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS stored_at timestamptz;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS attempted_at timestamptz;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS delivery_notes text;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS delivery_signature text;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS delivery_photo text;
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS id_verification text;
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS packages_instance_created_idx ON packages (instance_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS packages_instance_status_created_idx ON packages (instance_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS packages_instance_storage_created_idx ON packages (instance_id, storage_location_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS packages_instance_tracking_idx ON packages (instance_id, tracking_number);
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
