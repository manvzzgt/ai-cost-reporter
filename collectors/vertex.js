require("dotenv").config();
const { BigQuery } = require("@google-cloud/bigquery");
const axios = require("axios");

const GCP_PROJECT  = "viva-calidad-ia";
const DATASET      = "billing_export";
const TABLE        = "gcp_billing_export_v1_01C77B_46625E_B652C8";

const bigqueryOptions = { projectId: GCP_PROJECT };
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  bigqueryOptions.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
}
const bigquery = new BigQuery(bigqueryOptions);

// ==========================
// 🔹 SKU → operation_type + tier
// ==========================
function classifySku(sku = "") {
  const s = sku.toLowerCase();

  // Caching (evaluar antes que Input genérico)
  // Cubre "* Caching" (Vertex) y "cached input token" (Gemini API)
  if (s.includes("caching") || s.includes("cached")) {
    const tier = s.includes("priority") ? "priority" : "standard";
    return { operation_type: "input_cached", tier };
  }

  // Thinking / Reasoning output
  if (s.includes("thinking")) {
    const tier = s.includes("priority") ? "priority" : "standard";
    return { operation_type: "output_thinking", tier };
  }

  // Output
  if (s.includes("output")) {
    const tier = s.includes("priority") ? "priority" : "standard";
    return { operation_type: "output_text", tier };
  }

  // Audio input
  if (s.includes("audio") && s.includes("input")) {
    const tier = s.includes("priority") ? "priority" : "standard";
    return { operation_type: "input_audio", tier };
  }

  // Image input
  if (s.includes("image") && s.includes("input")) {
    return { operation_type: "input_image", tier: "standard" };
  }

  // Text input (fallback para cualquier input)
  if (s.includes("input")) {
    const tier = s.includes("priority") ? "priority" : "standard";
    return { operation_type: "input_text", tier };
  }

  return { operation_type: "input_text", tier: "standard" };
}

// ==========================
// 🔹 SKU → model name
// ==========================
const MODEL_PATTERNS = [
  "gemini-3-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
];

function extractModel(sku = "") {
  const s = sku.toLowerCase();
  for (const model of MODEL_PATTERNS) {
    if (s.includes(model)) return model;
  }
  // Fallback: intentar capturar "gemini-X.Y-word" genérico
  const match = s.match(/gemini[\s-](\d[\d.]*[\s-]\w+)/);
  if (match) return `gemini-${match[1].replace(/\s+/g, "-")}`;
  return "unknown";
}

// ==========================
// 🔹 TIPO DE CAMBIO MXN → USD
// ==========================
async function fetchFxRate() {
  const response = await axios.get("https://api.frankfurter.app/latest?from=MXN&to=USD");
  // rates.USD = cuántos USD vale 1 MXN  →  invertir para obtener MXN por USD
  const usdPerMxn = response.data.rates.USD;
  return Number((1 / usdPerMxn).toFixed(6));
}

// ==========================
// 🔹 QUERY BIGQUERY
// ==========================
async function queryBilling(date) {
  const query = `
    SELECT
      DATE(usage_start_time) AS date,
      (SELECT value FROM UNNEST(labels) WHERE key = 'servicio') AS user_name,
      sku.description AS sku_raw,
      project.id AS project_id,
      SUM(cost) AS total_mxn,
      SUM(usage.amount) AS total_units
    FROM \`${GCP_PROJECT}.${DATASET}.${TABLE}\`
    WHERE DATE(usage_start_time) = '${date}'
      AND (
        (service.description LIKE '%Vertex%'
         AND (SELECT value FROM UNNEST(labels) WHERE key = 'servicio') IS NOT NULL)
        OR
        (service.description LIKE '%Gemini%'
         AND (SELECT value FROM UNNEST(labels) WHERE key = 'servicio') IS NULL)
      )
    GROUP BY 1, 2, 3, 4
  `;

  const [rows] = await bigquery.query({ query });
  return rows;
}

// ==========================
// 🔹 RANGO UTC DIA ANTERIOR
// ==========================
function getYesterdayDate() {
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return yesterday.toISOString().split("T")[0];
}

// ==========================
// 🔥 COLLECT
// ==========================
async function collect({ date } = {}) {
  const targetDate = date ?? getYesterdayDate();

  console.log(`[vertex] Consultando BigQuery para fecha: ${targetDate}`);

  const [rows, fxRate] = await Promise.all([
    queryBilling(targetDate),
    fetchFxRate(),
  ]);

  const results = [];

  for (const row of rows) {
    const sku = row.sku_raw || "";

    // Filtrar SKUs que no sean de predicción, caching o generate content
    const skuLower = sku.toLowerCase();
    const isRelevant = skuLower.includes("predictions")
      || skuLower.includes("caching")
      || skuLower.includes("generate content");
    if (!isRelevant) continue;

    const { operation_type, tier } = classifySku(sku);
    const model      = extractModel(sku);
    const totalMxn   = Number((row.total_mxn || 0).toFixed(6));
    const totalUsd   = Number((totalMxn / fxRate).toFixed(6));
    const totalUnits = Math.round(row.total_units || 0);

    const isInput  = operation_type.startsWith("input_");
    const isOutput = operation_type.startsWith("output_");

    results.push({
      date:           targetDate,
      project_id:     row.project_id || GCP_PROJECT,
      user_name:      row.user_name  || "gemini-api-direct",
      model,
      operation_type,
      tier,
      input_units:    isInput  ? totalUnits : 0,
      output_units:   isOutput ? totalUnits : 0,
      cached_tokens:  operation_type === "input_cached" ? totalUnits : 0,
      unit_type:      "tokens",
      requests:       null,
      total_usd:      totalUsd,
      total_mxn:      totalMxn,
      fx_rate:        fxRate,
      sku_raw:        sku,
    });
  }

  results.sort((a, b) => b.total_usd - a.total_usd);

  console.log(`[vertex] ${results.length} registros normalizados (fx_rate: ${fxRate} MXN/USD)`);

  return results;
}

module.exports = { collect };
