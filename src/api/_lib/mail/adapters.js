// The mailbox adapters by provider key. A new provider is one module that has
// the shape of outlook.js, plus one line here.

import * as outlook from "./outlook.js";

const ADAPTERS = { outlook };

export const PROVIDERS = Object.keys(ADAPTERS);
export const getAdapter = (provider) => ADAPTERS[provider] || null;
