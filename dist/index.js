"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const express_1 = __importDefault(require("express"));
const telegram_1 = __importDefault(require("./telegram"));
const app = (0, express_1.default)();
const PORT = 3000;
app.get("/", (req, res) => {
    res.send("Luna is running 🚀");
});
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
// Iniciar el bot de Telegram
telegram_1.default.launch().then(() => console.log("Luna está vivo en Telegram"));
