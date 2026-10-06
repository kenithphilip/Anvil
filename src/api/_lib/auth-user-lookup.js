// Find a Supabase auth user by email — correctly.
//
// Five call sites did this:
//
//   svc.auth.admin.listUsers({ page: 1, perPage: 1, email })
//
// @supabase/auth-js 2.105.1 forwards ONLY page and per_page
// (node_modules/@supabase/auth-js/dist/main/GoTrueAdminApi.js:428-440 builds
// `query: { page, per_page }`). Every other key — `email`, and the `filter`
// variant magic_link.js used — is dropped without error. So the call returns
// "the first user in the entire project", and each caller then treated that
// stranger as the person who had just typed their address.
//
// What that produced:
//   signup.js        409 "an account already exists" for EVERY new user once
//                    the project had one, killing self-serve onboarding
//   passkey/*.js     the credential verified against the wrong account
//   request_reset.js the reset audited against the wrong account
//
// The SDK has no getUserByEmail; only getUserById. So this pages and matches.
// That is what the original project-wide scan did, and the audit item those
// comments cite (H11) was about a MEMBER LIST built from a truncated global
// scan leaking other tenants' emails. Returning at most ONE exact-match user to
// a caller that already supplied the address leaks nothing.
//
// `exhaustive` is the part that matters. If the page budget runs out we have
// NOT proved the address is unused, and a caller must not report "no such
// account" on that basis — a false negative here creates a duplicate account or
// silently declines a password reset.

const PER_PAGE = 1000;
// Read per call, not at module load: a value captured at import time cannot be
// changed by configuration after the module is first required, which makes the
// bound untestable and un-tunable in a running deployment.
const maxPages = () => {
  const n = Number(process.env.AUTH_LOOKUP_MAX_PAGES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
};

/** Auth emails are case-insensitive; compare them that way. */
export const normaliseEmail = (e) => String(e ?? "").trim().toLowerCase();

/**
 * @returns {Promise<{user: object|null, exhaustive: boolean, pages: number}>}
 *   `exhaustive` false means the search was cut short — user:null is "unknown",
 *   not "absent".
 */
export const findUserByEmail = async (svc, email) => {
  const want = normaliseEmail(email);
  if (!want) return { user: null, exhaustive: true, pages: 0 };

  const cap = maxPages();
  for (let page = 1; page <= cap; page += 1) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error("listUsers: " + error.message);
    const users = data?.users || [];
    const hit = users.find((u) => normaliseEmail(u?.email) === want);
    if (hit) return { user: hit, exhaustive: true, pages: page };
    // A short page is the last page: the address genuinely is not registered.
    if (users.length < PER_PAGE) return { user: null, exhaustive: true, pages: page };
  }
  // eslint-disable-next-line no-console
  console.warn(`[auth-lookup] gave up after ${cap} pages; cannot conclude the address is unused`);
  return { user: null, exhaustive: false, pages: cap };
};
