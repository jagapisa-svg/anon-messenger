const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===== DATABASE =====

const db = new sqlite3.Database("./database.db");

db.serialize(() => {

    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            phone TEXT UNIQUE,
            name TEXT,
            surname TEXT,
            bio TEXT,
            avatar TEXT,
            country TEXT,
            blocked TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            fromId TEXT,
            toId TEXT,
            text TEXT,
            time TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name TEXT,
            owner TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS group_members (
            groupId TEXT,
            userId TEXT
        )
    `);

});

console.log("Database ready");

// ===== COUNTRY MAP =====

const countryMap = {
    "+7": { name: "Russia", flag: "🇷🇺", length: 11 },
    "+375": { name: "Belarus", flag: "🇧🇾", length: 12 },
    "+1": { name: "USA", flag: "🇺🇸", length: 11 },
    "+380": { name: "Ukraine", flag: "🇺🇦", length: 12 },
    "+7KZ": { name: "Kazakhstan", flag: "🇰🇿", length: 11 },
    "+86": { name: "China", flag: "🇨🇳", length: 13 }
};

// ===== SMS CODES =====

let smsCodes = {};

function validatePhone(phone) {
    for (let code in countryMap) {
        if (phone.startsWith(code.replace("KZ", ""))) {
            const digits = phone.replace(/\D/g, "");
            return digits.length === countryMap[code].length;
        }
    }
    return false;
}

// ===== REGISTER =====

app.post("/register", (req, res) => {
    const { phone } = req.body;

    if (!validatePhone(phone)) {
        return res.status(400).json({ error: "Invalid phone number" });
    }

    const code = Math.floor(100000 + Math.random() * 900000);
    smsCodes[phone] = code;

    console.log("SMS CODE for", phone, ":", code);

    res.json({ success: true });
});

// ===== VERIFY =====

app.post("/verify", (req, res) => {
    const { phone, code } = req.body;

    if (smsCodes[phone] != code) {
        return res.status(400).json({ error: "Invalid code" });
    }

    db.get(`SELECT id FROM users WHERE phone = ?`, [phone], (err, row) => {

        if (row) {
            // Пользователь уже существует
            return res.json({ success: true, userId: row.id });
        }

        // Новый пользователь
        const userId = uuidv4().slice(0, 8);

        db.run(`
            INSERT INTO users 
            (id, phone, name, surname, bio, avatar, country, blocked)
            VALUES (?, ?, '', '', '', '', '', '')
        `, [userId, phone], (err) => {

            if (err) {
                return res.status(500).json({ error: "Database error" });
            }

            res.json({ success: true, userId });
        });

    });
});

// ===== ACTIVE CONNECTIONS =====

let clients = {};

wss.on("connection", (ws) => {

    ws.on("message", (message) => {
        const data = JSON.parse(message);

        // USER CONNECT
        if (data.type === "connect") {
            clients[data.userId] = ws;
        }

        // SEND MESSAGE
if (data.type === "message") {

    db.get(`SELECT blocked FROM users WHERE id = ?`, [data.to], (err, row) => {

        if (row && row.blocked && row.blocked.includes(data.from)) {
            return;
        }

        const messageId = uuidv4();
        const time = new Date().toISOString();

        db.run(`
            INSERT INTO messages (id, fromId, toId, text, time)
            VALUES (?, ?, ?, ?, ?)
        `, [messageId, data.from, data.to, data.text, time]);

        if (clients[data.to]) {
            clients[data.to].send(JSON.stringify({
                type: "message",
                from: data.from,
                text: data.text,
                time
            }));
        }

    });
}

        // CLEAR CHAT
        if (data.type === "clearChat") {
            db.run(`
                DELETE FROM messages 
                WHERE (fromId = ? AND toId = ?)
                OR (fromId = ? AND toId = ?)
            `, [data.user1, data.user2, data.user2, data.user1]);
        }

        // BLOCK USER
        if (data.type === "block") {
            db.run(`
                UPDATE users 
                SET blocked = blocked || ',' || ?
                WHERE id = ?
            `, [data.blockedId, data.userId]);
        }

    });

    ws.on("close", () => {
        for (let id in clients) {
            if (clients[id] === ws) {
                delete clients[id];
            }
        }
    });

});

// ===== SEARCH USER BY ID =====

app.get("/user/:id", (req, res) => {
    db.get(`SELECT id, name, surname, bio, avatar FROM users WHERE id = ?`,
        [req.params.id],
        (err, row) => {
            if (!row) return res.status(404).json({ error: "User not found" });
            res.json(row);
        }
    );
});

// ===== UPDATE PROFILE =====

app.post("/updateProfile", (req, res) => {
    const { id, name, surname, bio, avatar } = req.body;

    db.run(`
        UPDATE users 
        SET name = ?, surname = ?, bio = ?, avatar = ?
        WHERE id = ?
    `, [name, surname, bio, avatar, id]);

    res.json({ success: true });
});

// ===== CREATE GROUP =====

app.post("/createGroup", (req, res) => {
    const { name, owner } = req.body;

    const groupId = uuidv4().slice(0, 8);

    db.run(`
        INSERT INTO groups (id, name, owner)
        VALUES (?, ?, ?)
    `, [groupId, name, owner]);

    db.run(`
        INSERT INTO group_members (groupId, userId)
        VALUES (?, ?)
    `, [groupId, owner]);

    res.json({ success: true, groupId });
});

// ===== START SERVER =====

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server running on port", PORT);
});
