// Single Vercel serverless function for the entire Anvil REST surface.
//
// Hobby plans cap a deployment at 12 functions. We consolidate every
// `/api/*` endpoint into ONE function that uses Vercel's catch-all
// dynamic route (`[...path].js`) and dispatches to the right handler
// inside src/api/router.js.
//
// All handlers continue to live as separate modules under src/api/.
// Adding or removing endpoints stays a one-file change in
// src/api/router.js — no Vercel config tweak needed.

import { dispatch } from "../src/api/router.js";

export default async function handler(req, res) {
  return dispatch(req, res);
}
