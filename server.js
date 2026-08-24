const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const PUBLIC = path.join(__dirname, "public");
const rooms = new Map();

function makeCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));
  return code;
}

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }

    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };

    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.id = crypto.randomUUID();
  ws.room = null;
  ws.role = null;

  send(ws, { type: "ready", id: ws.id });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "create") {
      const code = makeCode();
      rooms.set(code, {
        teacher: ws,
        students: new Map()
      });

      ws.room = code;
      ws.role = "teacher";

      return send(ws, {
        type: "created",
        room: code
      });
    }

    if (msg.type === "join") {
      const code = String(msg.room || "").trim().toUpperCase();
      const room = rooms.get(code);

      if (!room || !room.teacher || room.teacher.readyState !== WebSocket.OPEN) {
        return send(ws, {
          type: "error",
          message: "Classroom not found. Ask the teacher for a new code."
        });
      }

      ws.room = code;
      ws.role = "student";
      room.students.set(ws.id, ws);

      send(ws, {
        type: "joined",
        room: code,
        id: ws.id
      });

      send(room.teacher, {
        type: "student-joined",
        id: ws.id
      });

      return;
    }

    const room = ws.room ? rooms.get(ws.room) : null;
    if (!room) return;

    if (ws.role === "teacher") {
      if (msg.type === "offer" || msg.type === "ice") {
        const target = room.students.get(msg.target);
        if (target) {
          send(target, {
            type: msg.type,
            from: ws.id,
            description: msg.description,
            candidate: msg.candidate
          });
        }
      }

      if (msg.type === "stop") {
        for (const student of room.students.values()) {
          send(student, { type: "stop" });
        }
      }

      if (msg.type === "end") {
        for (const student of room.students.values()) {
          send(student, { type: "teacher-ended" });
        }
        rooms.delete(ws.room);
      }
    }

    if (ws.role === "student") {
      if (msg.type === "answer" || msg.type === "ice") {
        if (room.teacher) {
          send(room.teacher, {
            type: msg.type,
            from: ws.id,
            target: msg.target || room.teacher.id,
            description: msg.description,
            candidate: msg.candidate
          });
        }
      }
    }
  });

  ws.on("close", () => {
    const room = ws.room ? rooms.get(ws.room) : null;
    if (!room) return;

    if (ws.role === "teacher") {
      for (const student of room.students.values()) {
        send(student, { type: "teacher-ended" });
      }
      rooms.delete(ws.room);
    } else if (ws.role === "student") {
      room.students.delete(ws.id);
      send(room.teacher, {
        type: "student-left",
        id: ws.id
      });
    }
  });
});

setInterval(() => {
  for (const [code, room] of rooms) {
    if (!room.teacher || room.teacher.readyState !== WebSocket.OPEN) {
      rooms.delete(code);
    }
  }
}, 60000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Classroom Live Share running on port ${PORT}`);
});
