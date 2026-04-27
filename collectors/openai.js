require("dotenv").config();
const axios = require("axios");

const ADMIN_KEY = process.env.OPENAI_ADMIN_KEY;

const headers = {
  Authorization: `Bearer ${ADMIN_KEY}`,
};

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
    start_time: Math.floor(yesterdayStartUTC.getTime() / 1000),
    end_time: Math.floor(todayStartUTC.getTime() / 1000),
  };
}

// ==========================
// 🔹 RETRY CON BACKOFF
// ==========================
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS  = [2000, 4000, 8000];

async function fetchWithRetry(url, params) {
  let lastError;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await axios.get(url, { headers, params, timeout: 120000 });
    } catch (err) {
      const status = err.response?.status;
      if (!RETRYABLE_STATUS.has(status) || attempt === RETRY_DELAYS_MS.length) {
        throw err;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`[openai] Reintento ${attempt + 1}/3 — status ${status} en ${url} (esperando ${delay}ms)`);
      lastError = err;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ==========================
// 🔹 PAGINACION
// ==========================
async function fetchAllPages(url, params) {
  let results = [];
  let page = null;

  do {
    const response = await fetchWithRetry(url, page ? { ...params, page } : params);

    results.push(...response.data.data);
    page = response.data.has_more ? response.data.next_page : null;

  } while (page);

  return results;
}

// ==========================
// 🔹 OPERATION TYPE
// ==========================
function getOperationType(lineItem = "", isEmbedding = false) {
  if (isEmbedding) return "input_text";
  const l = lineItem.toLowerCase();
  if (l.includes("input") && l.includes("cached")) return "input_cached";
  if (l.includes("input"))                          return "input_text";
  if (l.includes("reasoning") || l.includes("thinking")) return "output_thinking";
  if (l.includes("output"))                         return "output_text";
  return "input_text";
}

// ==========================
// 🔹 CARGAR USER MAP
// ==========================
async function loadUserMap() {
  const projects = await fetchAllPages(
    "https://api.openai.com/v1/organization/projects",
    { limit: 100 }
  );

  const userMap = {};

  for (const project of projects) {
    const serviceAccounts = await fetchAllPages(
      `https://api.openai.com/v1/organization/projects/${project.id}/service_accounts`,
      { limit: 100 }
    );

    serviceAccounts.forEach(account => {
      userMap[account.id] = account.name;
    });
  }

  const orgUsers = await fetchAllPages(
    "https://api.openai.com/v1/organization/users",
    { limit: 100 }
  );

  orgUsers.forEach(user => {
    userMap[user.id] = user.name || user.email;
  });

  return userMap;
}

// ==========================
// 🔥 COLLECT
// ==========================
async function collect({ start_time, end_time, userMap } = {}) {
  if (!start_time || !end_time) {
    ({ start_time, end_time } = getYesterdayRange());
  }

  const date = new Date(start_time * 1000).toISOString().split("T")[0];

  console.log("Consultando rango:", start_time, end_time);

  // ==========================
  // 1️⃣ TRAER COSTS
  // ==========================
  const costBuckets = await fetchAllPages(
    "https://api.openai.com/v1/organization/costs",
    {
      start_time,
      end_time,
      bucket_width: "1d",
      group_by: ["user_id"],
      limit: 31,
    }
  );

  const usageMap = {};
  const modelsSet = new Set();

  costBuckets.forEach(bucket => {
    bucket.results.forEach(item => {
      const userId = item.user_id;
      const projectId = item.project_id || "";
      const amount = parseFloat(item.amount?.value || 0);
      const lineItem = item.line_item || "";
      const model = lineItem ? lineItem.split(",")[0].trim() : "";
      const isEmbedding = model.includes("embedding");
      const opType = getOperationType(lineItem, isEmbedding);

      modelsSet.add(model);

      const key = `${userId}_${model}_${opType}_${projectId}`;

      if (!usageMap[key]) {
        usageMap[key] = {
          date,
          user_id: userId,
          project_id: projectId,
          model,
          operation_type: opType,
          sku_raw: lineItem,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          requests: 0,
          total_usd: 0,
        };
      }

      usageMap[key].total_usd += amount;
    });
  });

  // ==========================
  // 2️⃣ TRAER USAGE POR CADA MODELO
  // ==========================
  const models = Array.from(modelsSet);

  const completionModels = [];
  const embeddingModels = [];

  for (const model of models) {
    if (model.includes("embedding")) {
      embeddingModels.push(model);
    } else {
      completionModels.push(model);
    }
  }

  const fetchCompletionUsage = async (model) => {
    const usageBuckets = await fetchAllPages(
      "https://api.openai.com/v1/organization/usage/completions",
      {
        start_time,
        end_time,
        bucket_width: "1d",
        group_by: ["user_id"],
        models: [model],
        limit: 31,
      }
    );

    usageBuckets.forEach(bucket => {
      bucket.results.forEach(item => {
        const keyPrefix = `${item.user_id}_${model}_`;
        const inputTokens  = item.input_tokens || 0;
        const outputTokens = item.output_tokens || 0;
        const cachedTokens = item.input_cached_tokens || 0;
        const requests     = item.num_model_requests || 0;

        Object.keys(usageMap)
          .filter(k => k.startsWith(keyPrefix))
          .forEach(k => {
            const opType = usageMap[k].operation_type;

            if (opType === "input_text") {
              usageMap[k].input_tokens  = inputTokens - cachedTokens;
              usageMap[k].output_tokens = 0;
              usageMap[k].cached_tokens = cachedTokens;
              usageMap[k].requests      = requests;
            } else if (opType === "input_cached") {
              usageMap[k].input_tokens  = cachedTokens;
              usageMap[k].output_tokens = 0;
              usageMap[k].cached_tokens = cachedTokens;
              usageMap[k].requests      = 0;
            } else if (opType === "output_text" || opType === "output_thinking") {
              usageMap[k].input_tokens  = 0;
              usageMap[k].output_tokens = outputTokens;
              usageMap[k].cached_tokens = 0;
              usageMap[k].requests      = 0;
            }
          });
      });
    });
  };

  const fetchEmbeddingUsage = async (model) => {
    const usageBuckets = await fetchAllPages(
      "https://api.openai.com/v1/organization/usage/embeddings",
      {
        start_time,
        end_time,
        bucket_width: "1d",
        group_by: ["user_id"],
        models: [model],
        limit: 31,
      }
    );

    usageBuckets.forEach(bucket => {
      bucket.results.forEach(item => {
        const keyPrefix = `${item.user_id}_${model}_`;
        Object.keys(usageMap)
          .filter(k => k.startsWith(keyPrefix))
          .forEach(k => {
            usageMap[k].input_tokens = item.input_tokens || 0;
            usageMap[k].output_tokens = 0;
            usageMap[k].cached_tokens = 0;
            usageMap[k].requests = item.num_model_requests || 0;
          });
      });
    });
  };

  await Promise.all([
    ...completionModels.map(fetchCompletionUsage),
    ...embeddingModels.map(fetchEmbeddingUsage),
  ]);

  // ==========================
  // 3️⃣ RESOLVER USUARIOS
  // ==========================
  const resolvedUserMap = userMap ?? await loadUserMap();

  // ==========================
  // 4️⃣ FORMATEAR RESULTADO FINAL
  // ==========================
  const results = Object.values(usageMap).map(item => ({
    date: item.date,
    project_id: item.project_id,
    user_name: resolvedUserMap[item.user_id] || "Unknown",
    model: item.model,
    operation_type: item.operation_type,
    tier: null,
    input_units: item.input_tokens,
    output_units: item.output_tokens,
    cached_tokens: item.cached_tokens,
    unit_type: "tokens",
    requests: item.requests,
    total_usd: Number(item.total_usd.toFixed(6)),
    total_mxn: null,
    fx_rate: null,
    sku_raw: item.sku_raw,
  }));

  results.sort((a, b) => b.total_usd - a.total_usd);

  return results;
}

module.exports = { collect, loadUserMap };
