const { collect } = require("../collectors/vertex");
const { write } = require("../shared/s3Writer");

async function main() {
  const data = await collect();

  console.log(`\nTotal registros: ${data.length}`);
  console.log("\nPrimeros 3 resultados:");
  console.log(JSON.stringify(data.slice(0, 3), null, 2));

  const s3Path = await write({ data, provider: "vertex_ai", date: data[0].date });

  console.log(`\nPath S3: ${s3Path}`);
}

main().catch(err => {
  console.error("Error:", err.response?.data || err.message);
  process.exit(1);
});
