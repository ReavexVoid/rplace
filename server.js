const express = require("express");
const WebSocket = require("ws");
const mongoose = require("mongoose");
const path = require("path");

const app = express();
app.use(express.static("public"));

// Serve the HTML file directly (if needed)
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = app.listen(3000, () => {
    console.log("✅ Server running on http://localhost:3000");
    console.log("✅ WebSocket server ready");
});

const wss = new WebSocket.Server({ server });

// MongoDB connection with error handling
mongoose.connect("mongodb://127.0.0.1:27017/place", {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log("✅ MongoDB connected successfully");
}).catch(err => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
});

// Pixel schema with timestamps
const PixelSchema = new mongoose.Schema({
    key: { type: String, unique: true, required: true },
    color: { type: String, required: true, default: "#2d2f36" },
    lastUpdated: { type: Date, default: Date.now }
});

const Pixel = mongoose.model("Pixel", PixelSchema);

// In-memory cache for fast access
let canvas = {};

// Load canvas from database with error handling
async function loadCanvas() {
    try {
        const pixels = await Pixel.find().lean();
        pixels.forEach(p => {
            canvas[p.key] = p.color;
        });
        console.log(`📦 Loaded ${Object.keys(canvas).length} pixels from database`);
        
        // Initialize empty canvas if no data exists
        if (Object.keys(canvas).length === 0) {
            console.log("🖼️ Initializing empty canvas (50x50)");
            for (let i = 0; i < 50; i++) {
                for (let j = 0; j < 50; j++) {
                    const key = `${i}_${j}`;
                    canvas[key] = "#2d2f36";
                }
            }
        }
    } catch (error) {
        console.error("❌ Error loading canvas:", error);
        // Initialize empty canvas on error
        for (let i = 0; i < 50; i++) {
            for (let j = 0; j < 50; j++) {
                canvas[`${i}_${j}`] = "#2d2f36";
            }
        }
    }
}

// Save a single pixel to database
async function savePixel(key, color) {
    try {
        await Pixel.findOneAndUpdate(
            { key: key },
            { color: color, lastUpdated: Date.now() },
            { upsert: true }
        );
    } catch (error) {
        console.error(`❌ Error saving pixel ${key}:`, error);
    }
}

// Save all pixels to database (used for periodic backup)
async function saveAllPixels() {
    try {
        const operations = Object.entries(canvas).map(([key, color]) => ({
            updateOne: {
                filter: { key: key },
                update: { color: color, lastUpdated: Date.now() },
                upsert: true
            }
        }));
        
        if (operations.length > 0) {
            await Pixel.bulkWrite(operations, { ordered: false });
            console.log(`💾 Saved ${operations.length} pixels to database`);
        }
    } catch (error) {
        console.error("❌ Error during bulk save:", error);
    }
}

// Start loading canvas
loadCanvas().then(() => {
    // Periodic backup every 30 seconds
    setInterval(saveAllPixels, 30000);
    console.log("🔄 Auto-save enabled (every 30 seconds)");
});

// WebSocket connection handling
wss.on("connection", (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`🔌 New client connected from ${clientIP}`);
    
    // Send initial canvas state
    ws.send(JSON.stringify({
        type: "init",
        canvas: canvas
    }));
    
    // Handle incoming messages
    ws.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg);
            
            if (data.type === "place") {
                // Validate required fields
                if (!data.pixel || !data.color || !data.name) {
                    ws.send(JSON.stringify({
                        type: "error",
                        message: "Missing required fields"
                    }));
                    return;
                }
                
                // Validate pixel coordinates
                const [x, y] = data.pixel.split("_").map(Number);
                if (isNaN(x) || isNaN(y) || x < 0 || x >= 50 || y < 0 || y >= 50) {
                    ws.send(JSON.stringify({
                        type: "error",
                        message: "Invalid pixel coordinates"
                    }));
                    return;
                }
                
                // Validate color format (simple hex validation)
                if (!/^#[0-9A-Fa-f]{6}$/.test(data.color)) {
                    ws.send(JSON.stringify({
                        type: "error",
                        message: "Invalid color format"
                    }));
                    return;
                }
                
                // NO COOLDOWN CHECK - removed completely
                
                // Update canvas in memory
                const oldColor = canvas[data.pixel];
                canvas[data.pixel] = data.color;
                
                // Save to database (async, don't wait)
                savePixel(data.pixel, data.color);
                
                console.log(`🎨 ${data.name} placed pixel at ${data.pixel} (${oldColor} → ${data.color})`);
                
                // Broadcast to all connected clients
                const broadcastMessage = JSON.stringify({
                    type: "update",
                    pixel: data.pixel,
                    color: data.color,
                    name: data.name,
                    timestamp: Date.now()
                });
                
                let broadcastCount = 0;
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(broadcastMessage);
                        broadcastCount++;
                    }
                });
                
                console.log(`📡 Broadcasted update to ${broadcastCount} clients`);
            }
        } catch (error) {
            console.error("❌ Error processing message:", error);
            ws.send(JSON.stringify({
                type: "error",
                message: "Invalid message format"
            }));
        }
    });
    
    ws.on("close", () => {
        console.log(`🔌 Client disconnected`);
    });
    
    ws.on("error", (error) => {
        console.error("❌ WebSocket error:", error);
    });
});

// Graceful shutdown
process.on("SIGINT", async () => {
    console.log("\n🛑 Shutting down gracefully...");
    console.log("💾 Saving final canvas state...");
    await saveAllPixels();
    console.log("✅ Final save complete");
    
    // Close WebSocket connections
    wss.clients.forEach(client => {
        client.close();
    });
    
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log("✅ MongoDB disconnected");
    
    // Close server
    server.close(() => {
        console.log("✅ Server closed");
        process.exit(0);
    });
});

// Monitor memory usage
setInterval(() => {
    const used = process.memoryUsage();
    console.log(`📊 Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB / ${Math.round(used.heapTotal / 1024 / 1024)}MB`);
}, 60000);

// Connection status monitoring
setInterval(() => {
    console.log(`📡 Active connections: ${wss.clients.size}`);
}, 30000);
