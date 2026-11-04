// Keyword search over the multi-merchant catalog, with synonyms and a risk
// assessment attached to every result.
import { CATALOG, VERIFIED_MERCHANTS } from "./catalog.js";
import { assessListing } from "./risk.js";

const SYNONYMS = {
  camping: ["outdoor", "tent", "camp", "backpacking"],
  hiking: ["outdoor", "trail", "backpack", "hiking"],
  trip: ["outdoor"],
  office: ["desk", "chair", "keyboard", "mouse", "monitor", "webcam", "lamp"],
  wfh: ["desk", "chair", "keyboard", "mouse", "monitor", "webcam", "lamp"],
  work: ["keyboard", "mouse", "monitor", "webcam", "chair", "desk"],
  desk: ["keyboard", "mouse", "monitor", "webcam", "lamp", "chair"],
  snacks: ["trail mix", "grocery"],
  music: ["earbuds", "headphones"],
  earphones: ["earbuds", "headphones"],
  headset: ["headphones", "earbuds"],
  speakers: ["earbuds", "headphones"],
  audio: ["earbuds", "headphones"],
  kitchen: ["mug", "oil", "cook", "coffee"],
  gift: ["gift", "book", "mug", "plant"],
  food: ["grocery", "meals", "trail mix", "coffee", "tea"],
};


const STOPWORDS = new Set(
  "the and for with under over about please find buy get need want some keep plan cheap cheapest best good new one two people person persons weekend week month budget dollars usd me my our you your can could would should it its this that them they from into out also just around".split(" "),
);

export function queryTerms(query) {
  return String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

export function searchCatalog({ query = "", category, max_price }) {
  const words = queryTerms(query);
  const terms = new Set(words);
  for (const w of words) for (const s of SYNONYMS[w] || []) terms.add(s);
  const scored = CATALOG.filter((p) => (!category || p.category === category) && (!max_price || p.price <= max_price))
    .map((p) => {
      const hay = `${p.name} ${p.description} ${p.category} ${p.merchant}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += p.name.toLowerCase().includes(t) ? 3 : 1;
      return { p, score };
    })
    .filter((x) => x.score > 0 || terms.size === 0)
    .sort((a, b) => b.score - a.score || b.p.rating - a.p.rating)
    .slice(0, 10);
  return scored.map(({ p, score }) => {
    const risk = assessListing(p);
    return {
      ...p,
      relevance: score,
      merchant_verified: VERIFIED_MERCHANTS.includes(p.merchant),
      risk_flags: risk.injection.detected ? ["possible_prompt_injection_in_listing"] : [],
      risk,
    };
  });
}
