const { handler } = require("../index");

handler({ providers: ["openai", "vertex_ai"] })
  .then(() => console.log("Handler finalizado"))
  .catch(err => console.error("Error:", err));
