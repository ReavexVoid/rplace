require('dotenv').config(); // környezeti változók betöltése

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

/**
 * Serve static files from "public" folder
 */
app.use(express.static(path.join(__dirname, 'public')));

/**
 * MongoDB Connection
 */
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ MongoDB connected');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    process.exit(1); // exit app if DB connection fails
  }
}

/**
 * Pixel Schema + Model
 */
const pixelSchema = new mongoose.Schema({
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  color: { type: String, required: true },
});

const Pixel = mongoose.model('Pixel', pixelSchema);

/**
 * API Routes (opcionális)
 */
app.get('/api', (req, res) => {
  res.send('API running...');
});

app.get('/api/pixels', async (req, res) => {
  try {
    const pixels = await Pixel.find();
    res.json(pixels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * SPA fallback
 */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * HTTP + WebSocket Server
 */
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Memóriában tároljuk a canvas állapotát (init betöltéshez)
let pixelsCache = {};

// Betöltjük az összes pixelt MongoDB-ből a memóriába
async function loadPixels() {
  const allPixels = await Pixel.find();
  allPixels.forEach(p => {
    pixelsCache[`${p.x}_${p.y}`] = p.color;
  });
  console.log('✅ Pixels loaded into cache');
}

wss.on('connection', (ws) => {
  console.log('✅ WS client connected');

  // Küldjük el az aktuális canvas állapotot az új kliensnek
  ws.send(JSON.stringify({ type: 'init', canvas: pixelsCache }));

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === 'place') {
        const [x, y] = data.pixel.split('_').map(Number);
        const color = data.color;
        const pixelKey = `${x}_${y}`;

        // Mentés memóriába + MongoDB
        pixelsCache[pixelKey] = color;

        const pixelDoc = new Pixel({ x, y, color });
        await pixelDoc.save();

        // Broadcast minden kliensnek
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'update',
              pixel: pixelKey,
              color,
              name: data.name || 'anon'
            }));
          }
        });
      }
    } catch (err) {
      console.error('❌ WS error:', err);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    console.log('❌ WS client disconnected');
  });
});

/**
 * Indítás
 */
connectDB().then(async () => {
  await loadPixels(); // Betöltjük a pixeleket a memóriába
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});
