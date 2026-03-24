const express = require("express");
const WebSocket = require("ws");
const mongoose = require("mongoose");

const app = express();
app.use(express.static("public"));

const server = app.listen(3000, () => {
    console.log("Running on http://localhost:3000");
});

const wss = new WebSocket.Server({ server });

mongoose.connect("mongodb://127.0.0.1:27017/place");

const PixelSchema = new mongoose.Schema({
    key: String,
    color: String
});

const Pixel = mongoose.model("Pixel", PixelSchema);

let canvas = {};
let cooldowns = {};

async function loadCanvas() {
    const pixels = await Pixel.find();
    pixels.forEach(p => {
        canvas[p.key] = p.color;
    });
}
loadCanvas();

wss.on("connection", (ws) => {

    ws.send(JSON.stringify({
        type: "init",
        canvas: canvas
    }));

    ws.on("message", async (msg) => {
        const data = JSON.parse(msg);

        if (data.type === "place") {

            const now = Date.now();

            if (cooldowns[data.name] && now - cooldowns[data.name] < 5000) {
                return;
            }

            cooldowns[data.name] = now;

            canvas[data.pixel] = data.color;

            await Pixel.findOneAndUpdate(
                { key: data.pixel },
                { color: data.color },
                { upsert: true }
            );

            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: "update",
                        pixel: data.pixel,
                        color: data.color,
                        name: data.name
                    }));
                }
            });
        }
    });
});

setInterval(async () => {
    for (let key in canvas) {
        await Pixel.findOneAndUpdate(
            { key },
            { color: canvas[key] },
            { upsert: true }
        );
    }
}, 30000);