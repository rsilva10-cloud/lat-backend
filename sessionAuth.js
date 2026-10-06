/**
 * sessionAuth.js
 * --------------
 * Reuses the exact same login system already built for po-history-backend
 * — a valid PO Control session token (signed with the same SESSION_SECRET)
 * is accepted here too, rather than building a second, separate login for
 * this backend. Same pattern as fidelitone-backend and saia-backend.
 */

const jwt = require("jsonwebtoken");

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.warn(
    "WARNING: SESSION_SECRET is not set — this must match the value set on " +
    "po-history-backend, or no PO Control login session will be accepted here."
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not logged in" });
  try {
    req.user = jwt.verify(token, SESSION_SECRET || "");
    next();
  } catch (err) {
    res.status(401).json({ error: "Session expired or invalid — please log in again" });
  }
}

module.exports = { requireAuth };
