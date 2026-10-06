// Account owner on customers (migration 227): the shared pieces.
//
// The column is written only by /api/customers/owner and read by the customer
// list, the owner endpoint and the credit-review agent. What they share lives
// here so the "column not applied yet" rule and the suggestion rule have one
// definition each.

// Evidence window for a suggestion.
export const OWNER_WINDOW_DAYS = 365;

// An opportunity in one of these stages is closed; everything else is open.
// Same set as sales/opportunities.js TERMINAL_STAGES.
export const TERMINAL_OPPORTUNITY_STAGES = ["CLOSE_WON", "CLOSE_LOST", "REGRETTED"];

// True only when the error says customers.owner_user_id is missing, i.e. the
// database has not had migration 227 applied. A read filter on an absent
// column returns 42703 ("column customers.owner_user_id does not exist"); a
// write returns PGRST204 ("Could not find the 'owner_user_id' column ... in the
// schema cache"). The column name is required in the message: a 42703 about
// some OTHER column is a different fault and must not be swallowed here.
export const isMissingOwnerColumn = (err) => {
  if (!err) return false;
  const msg = String(err.message || "");
  if (!/owner_user_id/.test(msg)) return false;
  return err.code === "42703" || err.code === "PGRST204" || /does not exist|schema cache/i.test(msg);
};

// How far the owner endpoint pages a read (suggestion evidence, the open
// opportunities a move reads) before it gives up and says so. A module object
// rather than constants so a test can shrink it and drive the handler into
// its "could not read it all" paths without building 20,000 rows.
export const OWNER_READ_PAGING = { pageSize: 1000, maxPages: 20 };

// Ids per PostgREST `in.(...)` filter. The filter rides in the URL, and 500
// uuids is about 18 KB of query string, past what a proxy in front of
// PostgREST may accept. 100 keeps each request near 4 KB.
export const IN_CHUNK = 100;
export const chunk = (list, size = IN_CHUNK) => {
  const out = [];
  for (let i = 0; i < (list || []).length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// Read every row a query returns, a page at a time.
//
// PostgREST caps a response at its max-rows setting (1000 on Supabase) and
// says nothing when it does. A suggestion computed from the first 1000 quotes
// of a busy tenant would be computed from an arbitrary slice of the evidence,
// so this pages until a short page, and reports `complete: false` if it gave up
// first. makeQuery must return a FRESH ordered builder each call.
export const fetchAllRows = async (makeQuery, { pageSize = 1000, maxPages = 20 } = {}) => {
  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) return { rows, complete: false, error };
    const got = data || [];
    rows.push(...got);
    if (got.length < pageSize) return { rows, complete: true, error: null };
  }
  return { rows, complete: false, error: null };
};

// Count, per customer, how many records each person owns.
// records: [{ customer_id, owner }] where owner may be null. An unowned record
// still counts toward the customer's total: it is activity nobody can claim,
// and a majority has to be a majority of ALL the activity, not of the part
// that happens to carry a name.
export const tallyOwners = (records) => {
  const byCustomer = new Map();
  for (const r of records || []) {
    if (!r || !r.customer_id) continue;
    let t = byCustomer.get(r.customer_id);
    if (!t) { t = { total: 0, votes: new Map() }; byCustomer.set(r.customer_id, t); }
    t.total += 1;
    if (r.owner) t.votes.set(r.owner, (t.votes.get(r.owner) || 0) + 1);
  }
  return byCustomer;
};

// The person who owns a STRICT majority of a customer's records, else null.
// Strict: more than half. A tie, or a plurality short of half, is not a
// decision anybody made, so it is not offered as one.
export const strictMajorityOwner = (tally) => {
  if (!tally || !tally.total) return null;
  for (const [owner, votes] of tally.votes) {
    if (votes * 2 > tally.total) return { owner, votes, total: tally.total };
  }
  return null;
};
