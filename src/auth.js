import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";
import { pool, one } from "./db.js";

export function sessionMiddleware() {
  const PgStore = connectPgSimple(session);
  return session({
    store: new PgStore({
      pool,
      tableName: "sessions",
      createTableIfMissing: false,
    }),
    secret: process.env.SESSION_SECRET || "tracklet-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
}

export function requirePanel(req, res, next) {
  if (req.session?.panelUser) return next();
  res.status(401).json({ error: "Panel login required" });
}

export function requireInstance(req, res, next) {
  if (req.session?.instanceUser) return next();
  res.status(401).json({ error: "Instance login required" });
}

export function requireInstanceManager(req, res, next) {
  const role = req.session?.instanceUser?.role;
  if (role === "manager" || role === "admin") return next();
  res.status(403).json({ error: "Manager access required" });
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function currentInstance(instanceId) {
  return one(`SELECT * FROM instances WHERE id = $1`, [instanceId]);
}
