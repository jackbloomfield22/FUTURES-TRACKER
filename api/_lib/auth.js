import crypto from "node:crypto";
import { kv } from "./kv.js";

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

export function normEmail(e) {
  return String(e || "").trim().toLowerCase();
}

export function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), s, 64).toString("hex");
  return { salt: s, hash };
}

export function verifyPassword(password, salt, hash) {
  try {
    const test = crypto.scryptSync(String(password), salt, 64);
    const ref = Buffer.from(hash, "hex");
    return test.length === ref.length && crypto.timingSafeEqual(test, ref);
  } catch (e) {
    return false;
  }
}

export async function createSession(email) {
  const token = crypto.randomBytes(24).toString("hex");
  await kv.setex("session:" + token, SESSION_TTL, email);
  return token;
}

export async function sessionEmail(req) {
  const token = req.headers["x-fb-session"];
  if (!token || typeof token !== "string") return null;
  return await kv.get("session:" + token);
}

export async function destroySession(req) {
  const token = req.headers["x-fb-session"];
  if (token && typeof token === "string") await kv.del("session:" + token);
}

export function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body || "{}");
  } catch (e) {
    return {};
  }
}
