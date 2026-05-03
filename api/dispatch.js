// Single Vercel serverless function for the entire Anvil REST surface.
//
// Hobby plans cap a deployment at 12 functions. We consolidate every
// `/api/*` endpoint into ONE function and route every incoming
// `/api/<rest>` URL to this file via a `vercel.json` rewrite:
//
//   { "source": "/api/(.*)", "destination": "/api/dispatch" }
//
// Vercel preserves `req.url` to the original request URL for rewrites,
// so the dispatcher in `src/api/router.js` reads `req.url`, strips the
// `/api/` prefix, and looks up the matching handler.
//
// We deliberately use a plain filename (`api/dispatch.js`) instead of
// the Next.js-style catch-all (`api/[...path].js`). The bracket syntax
// is not reliably interpreted by Vercel's `version: 2` builder when
// `framework: null`, and the `functions` config glob treats `[...]` as
// a character class. The result: the function silently never deploys
// and every `/api/*` request returns Vercel's own 404.
//
// All handlers continue to live as separate modules under src/api/.
// Adding or removing endpoints stays a one-file change in
// src/api/router.js. No Vercel config tweak needed.

import { dispatch } from "../src/api/router.js";

export default async function handler(req, res) {
  return dispatch(req, res);
}
