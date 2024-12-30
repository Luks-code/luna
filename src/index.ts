import dotenv from "dotenv";
dotenv.config();

import express, { Request, Response } from "express";
import telegram from './telegram'

const app = express();
const PORT = 3000;

app.get("/", (req: Request, res: Response) => {
  res.send("Luna is running 🚀");
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

// Iniciar el bot de Telegram
telegram.launch().then(() => console.log("CachitoBot está vivo en Telegram"));
