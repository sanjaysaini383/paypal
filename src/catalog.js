// The multi-merchant product catalog and merchant registry. Read-only data:
// prices here are the only prices the server ever charges. Neither the model
// nor the browser can supply a price.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => JSON.parse(fs.readFileSync(path.join(here, "..", "data", file), "utf8"));

export const CATALOG = Object.freeze(read("catalog.json").map((p) => Object.freeze(p)));
const bySku = new Map(CATALOG.map((p) => [p.sku, p]));

export const getProduct = (sku) => bySku.get(sku);
export const hasProduct = (sku) => bySku.has(sku);

// "OUT-TENT-2P" -> "OUT-TENT": products of the same kind are substitutes.
export const kindOf = (sku) => String(sku).split("-").slice(0, 2).join("-");
