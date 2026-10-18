import "dotenv/config";
import { createApp } from "./app";
import { db } from "./db/database";

const app = createApp(db);

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});