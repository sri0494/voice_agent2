import jwt from "jsonwebtoken";

const EXPIRES_IN = () => process.env.JWT_EXPIRES_IN || "8h";
const secret = () => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not configured");
  return process.env.JWT_SECRET;
};

// HS256 is pinned on both sign and verify (no algorithm-confusion).
export function signToken(payload) {
  return jwt.sign(payload, secret(), { expiresIn: EXPIRES_IN(), algorithm: "HS256" });
}

export function verifyToken(token) {
  return jwt.verify(token, secret(), { algorithms: ["HS256"] });
}

/** The user id claim we accept. Anything else is refused (and logged by the caller). */
export const userIdFromClaims = (p) => p?.id ?? p?.userId ?? p?.sub ?? null;
