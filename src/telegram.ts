import { Telegraf } from "telegraf";
import generateText from "./textGenerator";

const bot = new Telegraf(process.env.TELEGRAM_TOKEN!);

const userAudioCount: Record<number, number> = {};

// Simula un tiempo de escritura basado en la longitud del mensaje
const calculateTypingDelay = (text: string): number => {
  const words = text.split(" ").length;
  const baseTimePerWord = 300; // Tiempo base en ms por palabra
  return Math.min(5000, words * baseTimePerWord); // Máximo 5 segundos
};

bot.start((ctx) =>
  ctx.reply(
    "Hey there, I'm Luna—ready to spice up your day?"
  )
);

bot.on("text", async (ctx) => {
  const userMessage = ctx.message.text;

  // Reset audio count if user writes text
  if (userAudioCount[ctx.from.id]) {
    userAudioCount[ctx.from.id] = 0;
  }

  try {
    ctx.telegram.sendChatAction(ctx.chat.id, "typing");

    const response = await generateText(userMessage);

    // Calcula el tiempo de escritura según la longitud del mensaje de respuesta
    const typingDelay = calculateTypingDelay(response);

    await new Promise((resolve) => setTimeout(resolve, typingDelay));

    ctx.reply(response);
  } catch (error) {
    ctx.telegram.sendChatAction(ctx.chat.id, "typing");
    await new Promise((resolve) => setTimeout(resolve, 1000));

    ctx.reply("Oops, something got tangled. Let’s chat a bit later, honey!");
  }
});

bot.on("voice", async (ctx) => {
  const userId = ctx.from.id;

  userAudioCount[userId] = (userAudioCount[userId] || 0) + 1;

  try {
    ctx.telegram.sendChatAction(ctx.chat.id, "typing");

    let response: string;

    if (userAudioCount[userId] === 1) {
      response = "Sorry, I can't hear voice notes, babe. Mind typing it out?";
    } else if (userAudioCount[userId] === 2) {
      response = "Told you, honey—I can't listen to voice notes. Type it for me?";
    } else if (userAudioCount[userId] >= 3) {
      response = "You're being a tease with those voice notes, but I still can't hear them.";
    } else {
      response = "I'm having trouble with voice notes right now. Could you write instead?";
    }

    // Calcula el tiempo de escritura según la longitud del mensaje
    const typingDelay = calculateTypingDelay(response);

    await new Promise((resolve) => setTimeout(resolve, typingDelay));

    ctx.reply(response);
  } catch (error) {
    ctx.telegram.sendChatAction(ctx.chat.id, "typing");
    await new Promise((resolve) => setTimeout(resolve, 1000));

    ctx.reply("I'm having trouble with voice notes right now. Could you write instead?");
  }
});

export default bot;
