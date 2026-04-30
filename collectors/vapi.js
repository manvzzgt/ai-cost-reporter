require("dotenv").config();
const axios = require("axios");

// ==========================
// 🔹 RANGO UTC DIA ANTERIOR
// ==========================
function getYesterdayRange() {
  const now = new Date();

  const todayStartUTC = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));

  const yesterdayStartUTC = new Date(todayStartUTC);
  yesterdayStartUTC.setUTCDate(yesterdayStartUTC.getUTCDate() - 1);

  return {
    date: yesterdayStartUTC.toISOString().split("T")[0],
    start: yesterdayStartUTC.toISOString().replace(".000Z", "Z"),
    end:   todayStartUTC.toISOString().replace(".000Z", "Z"),
  };
}

const UNKNOWN_ASSISTANT_ID = "00000000-0000-0000-0000-000000000000";

// ==========================
// 🔹 ASSISTANT MAP POR ORG
// ==========================
async function fetchAssistantMap(key) {
  const response = await axios.get("https://api.vapi.ai/assistant", {
    headers: { Authorization: `Bearer ${key}` },
    timeout: 60000,
  });

  const map = {};
  for (const assistant of response.data) {
    map[assistant.id] = assistant.name;
  }
  return map;
}

// ==========================
// 🔹 ANALYTICS POR ORG
// ==========================
async function fetchAnalytics(key, start, end) {
  const response = await axios.post(
    "https://api.vapi.ai/analytics",
    {
      queries: [{
        table: "call",
        name: "daily_costs",
        timeRange: {
          start,
          end,
          step: "day",
          timezone: "UTC",
        },
        operations: [
          { operation: "sum",   column: "cost" },
          { operation: "count", column: "id" },
          { operation: "sum",   column: "costBreakdown.vapi" },
          { operation: "sum",   column: "costBreakdown.llmPromptTokens" },
          { operation: "sum",   column: "costBreakdown.llmCompletionTokens" },
          { operation: "sum",   column: "costBreakdown.ttsCharacters" },
          { operation: "sum",   column: "duration" },
        ],
        groupBy: ["assistantId"],
      }],
    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    }
  );

  // La API devuelve un array de resultados por query; tomamos la primera
  return response.data?.[0]?.result ?? [];
}

// ==========================
// 🔹 PROCESAR UNA ORG
// ==========================
async function collectOrg({ key, org }, date, start, end) {
  const [assistantMap, rows] = await Promise.all([
    fetchAssistantMap(key),
    fetchAnalytics(key, start, end),
  ]);

  const results = [];

  for (const row of rows) {
    const vapiCost = row.sumCostBreakdownVapi ?? 0;

    // Filtrar filas sin costo de orquestación VAPI
    if (!vapiCost) continue;

    const assistantId = row.assistantId;
    const userName = assistantId === UNKNOWN_ASSISTANT_ID
      ? "unknown"
      : (assistantMap[assistantId] || assistantId);

    const ttsChars    = Math.round(row.sumCostBreakdownTtsCharacters ?? 0);
    const callMinutes = Number((row.sumDuration ?? 0).toFixed(4));

    results.push({
      date,
      project_id:     org,
      user_name:      userName,
      model:          "vapi-orchestration",
      operation_type: "orchestration",
      tier:           null,
      input_units:    Math.round(row.sumCostBreakdownLlmPromptTokens      ?? 0),
      output_units:   Math.round(row.sumCostBreakdownLlmCompletionTokens  ?? 0),
      cached_tokens:  0,
      unit_type:      "tokens",
      requests:       Math.round(row.countId ?? 0),
      call_minutes:   callMinutes,
      total_usd:      Number(vapiCost.toFixed(6)),
      total_mxn:      null,
      fx_rate:        null,
      sku_raw:        `vapi-orchestration | mins:${callMinutes} | tts_chars:${ttsChars}`,
    });
  }

  console.log(`[vapi] org=${org} → ${results.length} registros`);
  return results;
}

// ==========================
// 🔥 COLLECT
// ==========================
async function collect({ date } = {}) {
  const apiKeys = JSON.parse(process.env.VAPI_API_KEYS);

  const range = getYesterdayRange();
  const targetDate  = date  ?? range.date;

  // Recalcular start/end si se pasó date explícita
  let start, end;
  if (date) {
    const d = new Date(`${date}T00:00:00Z`);
    const next = new Date(d);
    next.setUTCDate(next.getUTCDate() + 1);
    start = d.toISOString().replace(".000Z", "Z");
    end   = next.toISOString().replace(".000Z", "Z");
  } else {
    start = range.start;
    end   = range.end;
  }

  console.log(`[vapi] Consultando fecha: ${targetDate} (${start} → ${end})`);
  console.log(`[vapi] Orgs: ${apiKeys.map(k => k.org).join(", ")}`);

  const settled = await Promise.allSettled(
    apiKeys.map(entry => collectOrg(entry, targetDate, start, end))
  );

  const allResults = [];

  for (const [i, outcome] of settled.entries()) {
    const org = apiKeys[i].org;
    if (outcome.status === "fulfilled") {
      allResults.push(...outcome.value);
    } else {
      console.error(`[vapi] Error en org="${org}":`, outcome.reason?.message ?? outcome.reason);
    }
  }

  allResults.sort((a, b) => b.total_usd - a.total_usd);

  console.log(`[vapi] Total registros: ${allResults.length}`);

  return allResults;
}

module.exports = { collect };
