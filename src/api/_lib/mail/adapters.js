// The mailbox adapters by provider key. A new provider is one module that has
// the shape of outlook.js, plus one line here.

import * as outlook from "./outlook.js";
import * as gmail from "./gmail.js";

const ADAPTERS = { outlook, gmail };

export const PROVIDERS = Object.keys(ADAPTERS);
export const getAdapter = (provider) => ADAPTERS[provider] || null;
