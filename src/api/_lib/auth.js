import { serviceClient, userClient } from "./supabase.js";

const DEFAULT_TENANT = process.env.DEFAULT_TENANT_ID || "00000000-0000-0000-0000-000000000001";
const ALLOW_ANONYMOUS = String(process.env.ALLOW_ANONYMOUS_TENANT || "true").toLowerCase() === "true";

const VIEWER_ROLES = new Set(["viewer", "sales_engineer", "sales_manager", "procurement", "finance", "admin"]);
const WRITER_ROLES = new Set(["sales_engineer", "sales_manager", "procurement", "finance", "admin"]);
const APPROVER_ROLES = new Set(["sales_manager", "finance", "admin"]);
const ADMIN_ROLES = new Set(["admin"]);

const REQUIRED_ROLES = {
  read: VIEWER_ROLES,
  write: WRITER_ROLES,
  approve: APPROVER_ROLES,
  admin: ADMIN_ROLES,
};

export const resolveContext = async (req) => {
  const headerAuth = (req.headers.authorization || req.headers.Authorization || "").trim();
  const tenantHeader = (req.headers["x-obara-tenant"] || "").trim();
  if (!headerAuth) {
    if (!ALLOW_ANONYMOUS) {
      const err = new Error("Missing Authorization header");
      err.status = 401;
      throw err;
    }
    return { user: null, tenantId: tenantHeader || DEFAULT_TENANT, role: "sales_engineer", anonymous: true };
  }
  const token = headerAuth.replace(/^Bearer\s+/i, "");
  const supa = userClient(token);
  const { data, error } = await supa.auth.getUser();
  if (error || !data || !data.user) {
    const err = new Error("Invalid Authorization token");
    err.status = 401;
    throw err;
  }
  const user = data.user;
  const svc = serviceClient();
  const memberships = await svc.from("tenant_members").select("tenant_id, role").eq("user_id", user.id);
  if (memberships.error) {
    const err = new Error("Tenant lookup failed: " + memberships.error.message);
    err.status = 500;
    throw err;
  }
  const allowed = memberships.data || [];
  if (!allowed.length) {
    const err = new Error("User has no tenant membership");
    err.status = 403;
    throw err;
  }
  const tenantId = tenantHeader || allowed[0].tenant_id;
  const membership = allowed.find((m) => m.tenant_id === tenantId);
  if (!membership) {
    const err = new Error("User is not a member of tenant " + tenantId);
    err.status = 403;
    throw err;
  }
  return { user, tenantId, role: membership.role, anonymous: false };
};

export const requirePermission = (ctx, level) => {
  const required = REQUIRED_ROLES[level] || REQUIRED_ROLES.read;
  if (!required.has(ctx.role)) {
    const err = new Error("Role " + ctx.role + " is not allowed to perform " + level + " action");
    err.status = 403;
    throw err;
  }
};
