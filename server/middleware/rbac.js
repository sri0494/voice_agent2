import { ApiError } from "./errorHandler.js";
import { STAFF_ROLES } from "./auth.js";

export const R = {
  SA: "SUPER_ADMIN", ADMIN: "ADMIN", MGR: "MANAGER", AGENT: "AGENT", VIEWER: "VIEWER",
  STAFF: STAFF_ROLES,
  ADMINS: ["SUPER_ADMIN", "ADMIN"],
  MANAGERS: ["SUPER_ADMIN", "ADMIN", "MANAGER"],
  OPERATORS: ["SUPER_ADMIN", "ADMIN", "MANAGER", "AGENT"], // everyone except read-only VIEWER
};

/**
 * One policy per router, placed after requireAuth + requireStaff:
 *   router.use(requireAuth, requireStaff, rbac({ read: R.STAFF, write: R.MANAGERS, remove: R.ADMINS,
 *                                               rules: [{ method: "POST", path: /^\/:?[^/]+\/test$/, roles: R.OPERATORS }] }));
 * Reads (GET/HEAD) use `read`, DELETE uses `remove` (default `write`), everything else uses `write`.
 * `rules` are checked first (first match wins). VIEWER is therefore read-only unless a rule says otherwise.
 */
export function rbac({ read = R.STAFF, write = R.MANAGERS, remove, rules = [] }) {
  return (req, res, next) => {
    if (!req.user) return next(new ApiError(401, "Authentication required"));
    const rule = rules.find((r) => r.method === req.method && r.path.test(req.path));
    const allowed = rule ? rule.roles
      : ["GET", "HEAD", "OPTIONS"].includes(req.method) ? read
      : req.method === "DELETE" ? (remove || write) : write;
    if (!allowed.includes(req.user.role)) return next(new ApiError(403, "You do not have permission to perform this action"));
    next();
  };
}
